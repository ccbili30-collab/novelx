use std::{
    future::Future,
    path::{Path, PathBuf},
};

use novelx_protocol::{
    ContextCompilationReceipt, ProviderInferenceCompleted, ProviderInferenceIdentity,
    ProviderInferenceOutput, ProviderInferenceToolCall, ProviderInferenceUsage,
    ToolPermissionPolicy, ToolSourceScope,
};
use sha2::{Digest, Sha256};
use thiserror::Error;
use time::{OffsetDateTime, format_description::well_known::Rfc3339};
use uuid::Uuid;

use crate::{
    agent_loop_journal::{AgentLoopEventMetadata, AgentLoopJournalRepository},
    agent_loop_service::{
        AgentLoopDirective, AgentLoopIdentity, AgentLoopPolicy, AgentLoopService,
        FinalizedToolResult,
    },
    artifact_store::ArtifactStore,
    continuation_context_service::{ContinuationContextService, ContinuationContextServiceError},
    event_journal::{EventJournal, EventJournalError},
    project_path::ProjectRoot,
    project_tool_execution_service::{
        ProjectToolExecutionError, ProjectToolExecutionOutcome, ProjectToolExecutionService,
    },
    provider_gateway::{ProviderGateway, ProviderInferenceOutcome, ProviderRegistry},
    provider_inference_service::{
        ProviderInferenceExecution, ProviderInferenceService, ProviderInferenceServiceError,
    },
    provider_tool_materializer::{ProviderToolMaterializer, ProviderToolMaterializerError},
    run_aggregate::{RunAggregate, RunAggregateError},
    tool_coordination_service::ToolCoordinationStatus,
};
use crate::{
    artifact_store::ArtifactStore as LoopArtifactStore,
    tool_coordination_service::ToolCoordinationService,
};

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum LiveAgentLoopProgress {
    ProviderCompleted(ProviderInferenceCompleted),
    AwaitingApproval {
        requests: Vec<novelx_protocol::ToolRequest>,
        outcomes: Vec<ProjectToolExecutionOutcome>,
    },
    ToolsCompleted {
        requests: Vec<novelx_protocol::ToolRequest>,
        outcomes: Vec<ProjectToolExecutionOutcome>,
    },
    ContextCompiled(ContextCompilationReceipt),
    InferenceStarted(crate::agent_loop_service::NextInferenceIntent),
    Completed(String),
    Cancelled(String),
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum LiveAgentLoopOutcome {
    Completed {
        output: String,
        rounds: u32,
        completion: ProviderInferenceCompleted,
    },
    AwaitingApproval {
        invocation_id: String,
        tool_call_ids: Vec<Uuid>,
        completion: ProviderInferenceCompleted,
    },
    Cancelled,
}

pub struct LiveAgentLoopRunner {
    database_path: PathBuf,
    project_root: ProjectRoot,
    project_id: String,
    providers: ProviderRegistry,
    gateway: ProviderGateway,
    policy: AgentLoopPolicy,
}

impl LiveAgentLoopRunner {
    pub fn assist_ready(
        &self,
        run_id: Uuid,
        invocation_id: &str,
    ) -> Result<bool, LiveAgentLoopError> {
        let run_id_text = run_id.to_string();
        let loop_service = {
            let mut journal = EventJournal::open(&self.database_path)?;
            AgentLoopJournalRepository::new(&mut journal)
                .recover(&run_id_text, invocation_id)?
                .service
        };
        if loop_service.phase() != crate::agent_loop_service::LoopPhase::AwaitingApproval {
            return Err(LiveAgentLoopError::ResumeStateInvalid);
        }
        for request in loop_service.pending_requests() {
            let snapshot = {
                let mut journal = EventJournal::open(&self.database_path)?;
                let mut artifacts = LoopArtifactStore::open(&self.database_path)?;
                ToolCoordinationService::new(&mut journal, &mut artifacts)
                    .recover(&run_id_text, request.tool_call_id)?
            };
            if !matches!(
                snapshot.status,
                ToolCoordinationStatus::Succeeded
                    | ToolCoordinationStatus::Failed
                    | ToolCoordinationStatus::Denied
            ) {
                return Ok(false);
            }
        }
        Ok(true)
    }

    pub fn open(
        database_path: impl AsRef<Path>,
        project_root: ProjectRoot,
        project_id: String,
        providers: ProviderRegistry,
        gateway: ProviderGateway,
        policy: AgentLoopPolicy,
    ) -> Result<Self, LiveAgentLoopError> {
        if project_id.trim().is_empty() {
            return Err(LiveAgentLoopError::IdentityInvalid);
        }
        let database_path = database_path.as_ref().to_path_buf();
        EventJournal::open(&database_path)?;
        Ok(Self {
            database_path,
            project_root,
            project_id,
            providers,
            gateway,
            policy,
        })
    }

    pub async fn run<F, Fut, C>(
        &self,
        mut execution: ProviderInferenceExecution,
        initial_outcome: Option<ProviderInferenceOutcome>,
        mut progress: F,
        mut cancelled: C,
    ) -> Result<LiveAgentLoopOutcome, LiveAgentLoopError>
    where
        F: FnMut(LiveAgentLoopProgress) -> Fut,
        Fut: Future<Output = Result<(), LiveAgentLoopError>>,
        C: FnMut() -> bool,
    {
        let run_id =
            Uuid::parse_str(&execution.run_id).map_err(|_| LiveAgentLoopError::IdentityInvalid)?;
        let run =
            RunAggregate::recover(&EventJournal::open(&self.database_path)?, &execution.run_id)?;
        let pinned = run.pinned_identity();
        if pinned.project_id != self.project_id || execution.invocation_id.trim().is_empty() {
            return Err(LiveAgentLoopError::IdentityInvalid);
        }
        let identity = AgentLoopIdentity {
            run_id,
            project_id: self.project_id.clone(),
            invocation_id: execution.invocation_id.clone(),
            initial_context_compilation_id: execution.request.compilation.compilation_id,
            source_scope: ToolSourceScope {
                source_checkpoint_id: pinned.source_checkpoint_id.clone(),
                resource_ids: pinned.scope_resource_ids.clone(),
                scope_sha256: pinned.resource_scope_sha256.clone(),
            },
            permission: ToolPermissionPolicy {
                mode: pinned.mode,
                policy_id: pinned.tool_policy.id.clone(),
                policy_version: pinned.tool_policy.version.clone(),
                policy_sha256: pinned.tool_policy.sha256.clone(),
            },
        };
        let proposed = AgentLoopService::new(identity, self.policy)?;
        let mut loop_service;
        {
            let mut journal = EventJournal::open(&self.database_path)?;
            let events = journal.read_aggregate(
                &execution.run_id,
                "agent_loop",
                &execution.invocation_id,
                0,
            )?;
            if events.is_empty() {
                let message_id = Uuid::new_v4().to_string();
                let created_at = timestamp()?;
                AgentLoopJournalRepository::new(&mut journal).create(
                    &proposed,
                    &format!("agent-loop:{}:create", execution.invocation_id),
                    AgentLoopEventMetadata {
                        message_id: &message_id,
                        created_at: &created_at,
                    },
                )?;
                loop_service = proposed;
            } else {
                loop_service = AgentLoopJournalRepository::new(&mut journal)
                    .recover(&execution.run_id, &execution.invocation_id)?
                    .service;
                if !same_resumable_identity(loop_service.identity(), proposed.identity())
                    || loop_service.phase()
                        != crate::agent_loop_service::LoopPhase::AwaitingProvider
                {
                    return Err(LiveAgentLoopError::ResumeStateInvalid);
                }
            }
        }
        let mut next_outcome = initial_outcome;
        let mut rounds = 0_u32;
        loop {
            if cancelled() {
                let previous = loop_service.clone();
                let directive = loop_service.cancel("cancelled by host")?;
                self.append(&previous, &loop_service, &directive, "cancel")?;
                progress(LiveAgentLoopProgress::Cancelled(
                    "cancelled by host".to_owned(),
                ))
                .await?;
                return Ok(LiveAgentLoopOutcome::Cancelled);
            }
            let outcome = match next_outcome.take() {
                Some(outcome) => outcome,
                None => {
                    let mut journal = EventJournal::open(&self.database_path)?;
                    ProviderInferenceService::new(&mut journal, &self.providers, &self.gateway)
                        .execute(execution.clone())
                        .await?
                }
            };
            let completion = completed(&execution, &outcome)?;
            progress(LiveAgentLoopProgress::ProviderCompleted(completion.clone())).await?;
            let terminal_completion = completion.clone();
            let materialized = {
                let mut artifacts = ArtifactStore::open(&self.database_path)?;
                ProviderToolMaterializer::new(&mut artifacts).materialize(
                    &execution.run_id,
                    &execution.invocation_id,
                    &execution.inference_id,
                    &completion.tool_calls,
                )?
            };
            let previous = loop_service.clone();
            let directive = loop_service.accept_provider_outcome(completion, materialized)?;
            self.append(&previous, &loop_service, &directive, "provider-outcome")?;
            match directive {
                AgentLoopDirective::Completed { output } => {
                    progress(LiveAgentLoopProgress::Completed(output.clone())).await?;
                    return Ok(LiveAgentLoopOutcome::Completed {
                        output,
                        rounds,
                        completion: terminal_completion,
                    });
                }
                AgentLoopDirective::AwaitApproval(wait) => {
                    let tool_service = ProjectToolExecutionService::open(
                        &self.database_path,
                        self.project_root.clone(),
                        self.project_id.clone(),
                    )?;
                    let outcomes = tool_service
                        .execute_provider_calls(
                            &execution.run_id,
                            &execution.invocation_id,
                            &execution.inference_id,
                            &outcome
                                .tool_calls
                                .iter()
                                .map(protocol_call)
                                .collect::<Vec<_>>(),
                            &timestamp()?,
                        )
                        .await?;
                    progress(LiveAgentLoopProgress::AwaitingApproval {
                        requests: wait.requests.clone(),
                        outcomes,
                    })
                    .await?;
                    return Ok(LiveAgentLoopOutcome::AwaitingApproval {
                        invocation_id: execution.invocation_id,
                        tool_call_ids: wait
                            .requests
                            .iter()
                            .map(|request| request.tool_call_id)
                            .collect(),
                        completion: terminal_completion,
                    });
                }
                AgentLoopDirective::ExecuteTools(batch) => {
                    rounds += 1;
                    let tool_service = ProjectToolExecutionService::open(
                        &self.database_path,
                        self.project_root.clone(),
                        self.project_id.clone(),
                    )?;
                    let outcomes = tool_service
                        .execute_provider_calls(
                            &execution.run_id,
                            &execution.invocation_id,
                            &execution.inference_id,
                            &outcome
                                .tool_calls
                                .iter()
                                .map(protocol_call)
                                .collect::<Vec<_>>(),
                            &timestamp()?,
                        )
                        .await?;
                    progress(LiveAgentLoopProgress::ToolsCompleted {
                        requests: batch.requests,
                        outcomes: outcomes.clone(),
                    })
                    .await?;
                    let results = finalized_results(&self.database_path, outcomes)?;
                    let previous = loop_service.clone();
                    let directive = loop_service.accept_tool_results(results)?;
                    self.append(&previous, &loop_service, &directive, "tool-results")?;
                    let AgentLoopDirective::CompileContext(intent) = directive else {
                        return Err(LiveAgentLoopError::DirectiveInvalid);
                    };
                    let receipt = {
                        let mut journal = EventJournal::open(&self.database_path)?;
                        ContinuationContextService::new(&mut journal, &self.providers).apply(
                            run_id,
                            Uuid::new_v4(),
                            execution.request.compilation.compilation_id,
                            &intent,
                        )?
                    };
                    progress(LiveAgentLoopProgress::ContextCompiled(receipt.clone())).await?;
                    let previous = loop_service.clone();
                    let directive = loop_service.accept_context_compiled(receipt.compilation_id)?;
                    self.append(&previous, &loop_service, &directive, "context-compiled")?;
                    let AgentLoopDirective::StartInference(next) = directive else {
                        return Err(LiveAgentLoopError::DirectiveInvalid);
                    };
                    let previous = loop_service.clone();
                    loop_service.acknowledge_inference_started(next.request_number)?;
                    self.append_inference_started(&previous, &loop_service, next.request_number)?;
                    execution.attempt_id = Uuid::new_v4().to_string();
                    execution.inference_id = Uuid::new_v4().to_string();
                    execution.inference_idempotency_key = format!(
                        "agent-loop:{}:inference:{}",
                        execution.invocation_id, next.request_number
                    );
                    execution.attempt_number = 1;
                    execution.request.compilation = receipt;
                    progress(LiveAgentLoopProgress::InferenceStarted(next)).await?;
                }
                _ => return Err(LiveAgentLoopError::DirectiveInvalid),
            }
        }
    }

    pub async fn resume_after_assist<F, Fut, C>(
        &self,
        run_id: Uuid,
        invocation_id: &str,
        mut progress: F,
        cancelled: C,
    ) -> Result<LiveAgentLoopOutcome, LiveAgentLoopError>
    where
        F: FnMut(LiveAgentLoopProgress) -> Fut,
        Fut: Future<Output = Result<(), LiveAgentLoopError>>,
        C: FnMut() -> bool,
    {
        let run_id_text = run_id.to_string();
        let mut loop_service = {
            let mut journal = EventJournal::open(&self.database_path)?;
            AgentLoopJournalRepository::new(&mut journal)
                .recover(&run_id_text, invocation_id)?
                .service
        };
        if loop_service.phase() != crate::agent_loop_service::LoopPhase::AwaitingApproval {
            return Err(LiveAgentLoopError::ResumeStateInvalid);
        }
        let completion = loop_service
            .pending_completion()
            .cloned()
            .ok_or(LiveAgentLoopError::ResumeStateInvalid)?;
        let requests = loop_service.pending_requests().to_vec();
        let mut outcomes = Vec::with_capacity(requests.len());
        for request in &requests {
            let snapshot = {
                let mut journal = EventJournal::open(&self.database_path)?;
                let mut artifacts = LoopArtifactStore::open(&self.database_path)?;
                ToolCoordinationService::new(&mut journal, &mut artifacts)
                    .recover(&run_id_text, request.tool_call_id)?
            };
            outcomes.push(ProjectToolExecutionOutcome {
                tool_call_id: request.tool_call_id,
                provider_tool_call_id: request.provider_tool_call_id.clone(),
                tool_name: request.tool_name.clone(),
                snapshot,
            });
        }
        if outcomes.iter().any(|outcome| {
            !matches!(
                outcome.snapshot.status,
                ToolCoordinationStatus::Succeeded
                    | ToolCoordinationStatus::Failed
                    | ToolCoordinationStatus::Denied
            )
        }) {
            progress(LiveAgentLoopProgress::AwaitingApproval {
                requests: requests.clone(),
                outcomes,
            })
            .await?;
            return Ok(LiveAgentLoopOutcome::AwaitingApproval {
                invocation_id: invocation_id.to_owned(),
                tool_call_ids: requests
                    .iter()
                    .map(|request| request.tool_call_id)
                    .collect(),
                completion,
            });
        }
        let decisions = outcomes
            .iter()
            .map(|outcome| crate::agent_loop_service::AssistToolDecision {
                provider_tool_call_id: outcome.provider_tool_call_id.clone(),
                approved: outcome.snapshot.status != ToolCoordinationStatus::Denied,
            })
            .collect();
        let previous = loop_service.clone();
        let directive = loop_service.resolve_assist(decisions)?;
        self.append(&previous, &loop_service, &directive, "assist-resolved")?;
        progress(LiveAgentLoopProgress::ToolsCompleted {
            requests: requests.clone(),
            outcomes: outcomes.clone(),
        })
        .await?;
        let results = finalized_results(&self.database_path, outcomes)?;
        let previous = loop_service.clone();
        let directive = loop_service.accept_tool_results(results)?;
        self.append(&previous, &loop_service, &directive, "assist-tool-results")?;
        let AgentLoopDirective::CompileContext(intent) = directive else {
            return Err(LiveAgentLoopError::DirectiveInvalid);
        };
        let run = RunAggregate::recover(&EventJournal::open(&self.database_path)?, &run_id_text)?;
        let receipt = {
            let mut journal = EventJournal::open(&self.database_path)?;
            ContinuationContextService::new(&mut journal, &self.providers).apply(
                run_id,
                Uuid::new_v4(),
                completion.identity.context_compilation_id,
                &intent,
            )?
        };
        progress(LiveAgentLoopProgress::ContextCompiled(receipt.clone())).await?;
        let previous = loop_service.clone();
        let directive = loop_service.accept_context_compiled(receipt.compilation_id)?;
        self.append(
            &previous,
            &loop_service,
            &directive,
            "assist-context-compiled",
        )?;
        let AgentLoopDirective::StartInference(next) = directive else {
            return Err(LiveAgentLoopError::DirectiveInvalid);
        };
        let previous = loop_service.clone();
        loop_service.acknowledge_inference_started(next.request_number)?;
        self.append_inference_started(&previous, &loop_service, next.request_number)?;
        progress(LiveAgentLoopProgress::InferenceStarted(next)).await?;
        let execution = ProviderInferenceExecution {
            run_id: run_id_text,
            attempt_id: Uuid::new_v4().to_string(),
            inference_id: Uuid::new_v4().to_string(),
            invocation_id: invocation_id.to_owned(),
            inference_idempotency_key: format!(
                "agent-loop:{invocation_id}:inference:{}",
                next.request_number
            ),
            attempt_number: 1,
            provider: run.pinned_identity().provider.clone(),
            request: crate::provider_gateway::ProviderInferenceRequest {
                compilation: receipt,
                messages: vec![],
                tools: vec![],
            },
        };
        self.run(execution, None, progress, cancelled).await
    }

    fn append(
        &self,
        previous: &AgentLoopService,
        current: &AgentLoopService,
        directive: &AgentLoopDirective,
        suffix: &str,
    ) -> Result<(), LiveAgentLoopError> {
        let mut journal = EventJournal::open(&self.database_path)?;
        let message_id = Uuid::new_v4().to_string();
        let created_at = timestamp()?;
        AgentLoopJournalRepository::new(&mut journal).append_transition(
            previous,
            current,
            directive,
            &format!(
                "agent-loop:{}:{suffix}:{}",
                current.identity().invocation_id,
                checkpoint_sha256(current)?
            ),
            AgentLoopEventMetadata {
                message_id: &message_id,
                created_at: &created_at,
            },
        )?;
        Ok(())
    }

    fn append_inference_started(
        &self,
        previous: &AgentLoopService,
        current: &AgentLoopService,
        request_number: u64,
    ) -> Result<(), LiveAgentLoopError> {
        let mut journal = EventJournal::open(&self.database_path)?;
        let message_id = Uuid::new_v4().to_string();
        let created_at = timestamp()?;
        AgentLoopJournalRepository::new(&mut journal).append_inference_started(
            previous,
            current,
            &format!(
                "agent-loop:{}:inference-started:{request_number}",
                current.identity().invocation_id
            ),
            AgentLoopEventMetadata {
                message_id: &message_id,
                created_at: &created_at,
            },
        )?;
        Ok(())
    }
}

fn completed(
    execution: &ProviderInferenceExecution,
    outcome: &ProviderInferenceOutcome,
) -> Result<ProviderInferenceCompleted, LiveAgentLoopError> {
    let text = outcome.text.as_ref().map(|text| ProviderInferenceOutput {
        text: text.clone(),
        text_sha256: sha(text.as_bytes()),
        utf8_bytes: u64::try_from(text.len()).unwrap_or(u64::MAX),
    });
    Ok(ProviderInferenceCompleted {
        identity: ProviderInferenceIdentity {
            run_id: Uuid::parse_str(&execution.run_id)
                .map_err(|_| LiveAgentLoopError::IdentityInvalid)?,
            inference_id: Uuid::parse_str(&execution.inference_id)
                .map_err(|_| LiveAgentLoopError::IdentityInvalid)?,
            attempt_id: Uuid::parse_str(&execution.attempt_id)
                .map_err(|_| LiveAgentLoopError::IdentityInvalid)?,
            context_compilation_id: outcome.receipt.context_compilation_id,
            request_number: execution.request.compilation.request_number,
            attempt_number: u64::from(execution.attempt_number),
        },
        provider_id: execution.provider.provider_id.clone(),
        model_id: outcome.receipt.actual_model_id.clone(),
        response_id_sha256: outcome.receipt.response_id_sha256.clone(),
        response_body_sha256: outcome.receipt.response_body_sha256.clone(),
        stop_reason: outcome.receipt.finish_reason.clone(),
        usage: ProviderInferenceUsage {
            input_tokens: outcome.receipt.usage.input_tokens,
            output_tokens: outcome.receipt.usage.output_tokens,
            total_tokens: outcome.receipt.usage.total_tokens,
        },
        output: text,
        tool_calls: outcome.tool_calls.iter().map(protocol_call).collect(),
    })
}

fn protocol_call(call: &crate::provider_gateway::ProviderToolCall) -> ProviderInferenceToolCall {
    ProviderInferenceToolCall {
        id: call.id.clone(),
        name: call.name.clone(),
        arguments: call.arguments.clone(),
        arguments_sha256: call.arguments_sha256.clone(),
    }
}

fn same_resumable_identity(left: &AgentLoopIdentity, right: &AgentLoopIdentity) -> bool {
    left.run_id == right.run_id
        && left.project_id == right.project_id
        && left.invocation_id == right.invocation_id
        && left.source_scope == right.source_scope
        && left.permission == right.permission
}

fn finalized_results(
    database_path: &Path,
    outcomes: Vec<ProjectToolExecutionOutcome>,
) -> Result<Vec<FinalizedToolResult>, LiveAgentLoopError> {
    let artifacts = ArtifactStore::open(database_path)?;
    outcomes
        .into_iter()
        .map(|outcome| {
            if outcome.snapshot.status == ToolCoordinationStatus::Denied {
                let content = serde_json::json!({
                    "code": "TOOL_DENIED",
                    "message": "The host denied this tool call."
                });
                return Ok(FinalizedToolResult {
                    provider_tool_call_id: outcome.provider_tool_call_id,
                    tool_name: outcome.tool_name,
                    content_sha256: sha(&serde_json::to_vec(&content)?),
                    content,
                    is_error: true,
                });
            }
            let (receipt, is_error) = match outcome.snapshot.status {
                ToolCoordinationStatus::Succeeded => (outcome.snapshot.result, false),
                ToolCoordinationStatus::Failed => (outcome.snapshot.failure, true),
                _ => return Err(LiveAgentLoopError::ToolNotTerminal),
            };
            let receipt = receipt.ok_or(LiveAgentLoopError::ToolArtifactMissing)?;
            let stored = artifacts
                .get(receipt.artifact_id)?
                .ok_or(LiveAgentLoopError::ToolArtifactMissing)?;
            Ok(FinalizedToolResult {
                provider_tool_call_id: outcome.provider_tool_call_id,
                tool_name: outcome.tool_name,
                content: stored.content,
                content_sha256: receipt.sha256,
                is_error,
            })
        })
        .collect()
}

fn timestamp() -> Result<String, LiveAgentLoopError> {
    Ok(OffsetDateTime::now_utc().format(&Rfc3339)?)
}

fn sha(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn checkpoint_sha256(service: &AgentLoopService) -> Result<String, LiveAgentLoopError> {
    Ok(sha(&serde_json::to_vec(&service.checkpoint()?)?))
}

#[derive(Debug, Error)]
pub enum LiveAgentLoopError {
    #[error("live agent loop identity is invalid")]
    IdentityInvalid,
    #[error("live agent loop produced an unexpected directive")]
    DirectiveInvalid,
    #[error("project tool execution did not reach a terminal state")]
    ToolNotTerminal,
    #[error("project tool terminal artifact is missing")]
    ToolArtifactMissing,
    #[error("live agent loop cannot resume from its persisted phase")]
    ResumeStateInvalid,
    #[error("live agent loop progress could not be emitted: {0}")]
    Progress(String),
    #[error(transparent)]
    Loop(#[from] crate::agent_loop_service::AgentLoopError),
    #[error(transparent)]
    LoopJournal(#[from] crate::agent_loop_journal::AgentLoopJournalError),
    #[error(transparent)]
    Journal(#[from] EventJournalError),
    #[error(transparent)]
    Artifact(#[from] crate::artifact_store::ArtifactStoreError),
    #[error(transparent)]
    Tool(#[from] ProjectToolExecutionError),
    #[error(transparent)]
    Materializer(#[from] ProviderToolMaterializerError),
    #[error(transparent)]
    Continuation(#[from] ContinuationContextServiceError),
    #[error(transparent)]
    Provider(#[from] ProviderInferenceServiceError),
    #[error(transparent)]
    Run(#[from] RunAggregateError),
    #[error(transparent)]
    Time(#[from] time::error::Format),
    #[error(transparent)]
    Json(#[from] serde_json::Error),
    #[error(transparent)]
    Coordination(#[from] crate::tool_coordination_service::ToolCoordinationError),
}
