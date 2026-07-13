use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;

use novelx_protocol::{Envelope, MAX_SAFE_SEQUENCE, MessageType, PROTOCOL_VERSION};
use serde_json::Value;
use thiserror::Error;
use tokio::io::{AsyncWrite, AsyncWriteExt};
use tokio::sync::{mpsc, oneshot, watch};
use tokio::task::JoinSet;
use uuid::Uuid;

pub type RuntimeTask =
    Pin<Box<dyn Future<Output = Result<RuntimeOutputDraft, String>> + Send + 'static>>;

#[derive(Clone)]
pub struct RuntimeTaskProgressSender {
    key: RuntimeTaskKey,
    sender: mpsc::Sender<RuntimeTaskProgress>,
}

struct RuntimeTaskCompletion {
    key: RuntimeTaskKey,
    result: Result<RuntimeOutputDraft, String>,
    failure: RuntimeOutputDraft,
}

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub struct RuntimeTaskKey {
    pub run_id: Uuid,
    pub attempt_id: Uuid,
}

#[derive(Clone, Debug, PartialEq)]
pub struct RuntimeOutputDraft {
    pub message_type: MessageType,
    pub name: String,
    pub sent_at: String,
    pub correlation_id: Option<Uuid>,
    pub run_id: Option<Uuid>,
    pub payload: Value,
}

pub struct RuntimeActor<W> {
    writer: W,
    next_sequence: u64,
    commands: mpsc::Receiver<RuntimeActorCommand>,
    progress: mpsc::Receiver<RuntimeTaskProgress>,
    tasks: JoinSet<RuntimeTaskCompletion>,
    cancellations: HashMap<RuntimeTaskKey, watch::Sender<bool>>,
    lifecycle: RuntimeActorLifecycle,
    commands_open: bool,
    progress_open: bool,
}

#[derive(Clone)]
pub struct RuntimeActorHandle {
    commands: mpsc::Sender<RuntimeActorCommand>,
    progress: mpsc::Sender<RuntimeTaskProgress>,
}

#[must_use = "a begun drain must be awaited through finish_stop"]
pub struct RuntimeDrain {
    commands: mpsc::Sender<RuntimeActorCommand>,
    stopped: RuntimeOutputDraft,
    drained: oneshot::Receiver<()>,
}

enum RuntimeActorLifecycle {
    Running,
    Draining { drained: oneshot::Sender<()> },
    Drained,
}

struct RuntimeTaskProgress {
    key: RuntimeTaskKey,
    output: RuntimeOutputDraft,
    acknowledged: oneshot::Sender<()>,
}

enum RuntimeActorCommand {
    Emit(RuntimeOutputDraft),
    StartTask {
        key: RuntimeTaskKey,
        accepted: Option<RuntimeOutputDraft>,
        failure: RuntimeOutputDraft,
        cancellation: watch::Sender<bool>,
        task: RuntimeTask,
        acknowledged: oneshot::Sender<Result<(), RuntimeActorError>>,
    },
    CancelRun(Uuid),
    ActiveRunTasks {
        run_id: Uuid,
        reply: oneshot::Sender<Vec<RuntimeTaskKey>>,
    },
    BeginDrain {
        begun: oneshot::Sender<Result<(), RuntimeActorError>>,
        drained: oneshot::Sender<()>,
    },
    FinishStop {
        stopped: RuntimeOutputDraft,
        finished: oneshot::Sender<()>,
    },
}

impl<W> RuntimeActor<W>
where
    W: AsyncWrite + Unpin,
{
    pub fn new(
        writer: W,
        last_sequence: u64,
        mailbox_capacity: usize,
    ) -> (Self, RuntimeActorHandle) {
        let (sender, commands) = mpsc::channel(mailbox_capacity.max(1));
        let (progress_sender, progress) = mpsc::channel(mailbox_capacity.max(1));
        (
            Self {
                writer,
                next_sequence: last_sequence.checked_add(1).unwrap_or(0),
                commands,
                progress,
                tasks: JoinSet::new(),
                cancellations: HashMap::new(),
                lifecycle: RuntimeActorLifecycle::Running,
                commands_open: true,
                progress_open: true,
            },
            RuntimeActorHandle {
                commands: sender,
                progress: progress_sender,
            },
        )
    }

    pub async fn run(mut self) -> Result<(), RuntimeActorError> {
        loop {
            if self.finish_if_idle().await? {
                return Ok(());
            }
            tokio::select! {
                biased;
                command = self.commands.recv(), if self.commands_open => {
                    match command {
                        Some(RuntimeActorCommand::Emit(output)) => self.write(output).await?,
                        Some(RuntimeActorCommand::StartTask { key, accepted, failure, cancellation, task, acknowledged }) => {
                            if !matches!(self.lifecycle, RuntimeActorLifecycle::Running) {
                                let _ = acknowledged.send(Err(RuntimeActorError::Draining));
                                continue;
                            }
                            if let Some(accepted) = accepted {
                                self.write(accepted).await?;
                            }
                            self.cancellations.insert(key, cancellation);
                            self.tasks.spawn(async move {
                                RuntimeTaskCompletion {
                                    key,
                                    result: task.await,
                                    failure,
                                }
                            });
                            let _ = acknowledged.send(Ok(()));
                        }
                        Some(RuntimeActorCommand::CancelRun(run_id)) => {
                            for (key, cancellation) in &self.cancellations {
                                if key.run_id == run_id {
                                    let _ = cancellation.send(true);
                                }
                            }
                        }
                        Some(RuntimeActorCommand::ActiveRunTasks { run_id, reply }) => {
                            let tasks = self.cancellations
                                .keys()
                                .filter(|key| key.run_id == run_id)
                                .copied()
                                .collect();
                            let _ = reply.send(tasks);
                        }
                        Some(RuntimeActorCommand::BeginDrain { begun, drained }) => {
                            if !matches!(self.lifecycle, RuntimeActorLifecycle::Running) {
                                let _ = begun.send(Err(RuntimeActorError::AlreadyDraining));
                                continue;
                            }
                            self.lifecycle = RuntimeActorLifecycle::Draining { drained };
                            let _ = begun.send(Ok(()));
                        }
                        Some(RuntimeActorCommand::FinishStop { stopped, finished }) => {
                            if !matches!(self.lifecycle, RuntimeActorLifecycle::Drained) {
                                return Err(RuntimeActorError::NotDrained);
                            }
                            self.write(stopped).await?;
                            let _ = finished.send(());
                            return Ok(());
                        }
                        None => {
                            self.commands_open = false;
                        }
                    }
                }
                completed = self.tasks.join_next(), if !self.tasks.is_empty() => {
                    let completion = completed
                        .ok_or(RuntimeActorError::TaskSetEmpty)?
                        .map_err(RuntimeActorError::TaskJoin)?;
                    self.cancellations.remove(&completion.key);
                    let output = completion.result.unwrap_or(completion.failure);
                    self.write(output).await?;
                }
                progress = self.progress.recv(), if self.progress_open => {
                    match progress {
                        Some(progress) if self.cancellations.contains_key(&progress.key) => {
                            self.write(progress.output).await?;
                            let _ = progress.acknowledged.send(());
                        }
                        Some(_) => {}
                        None => self.progress_open = false,
                    }
                }
            }
        }
    }

    async fn finish_if_idle(&mut self) -> Result<bool, RuntimeActorError> {
        if !self.tasks.is_empty() {
            return Ok(false);
        }
        if matches!(self.lifecycle, RuntimeActorLifecycle::Draining { .. }) {
            let lifecycle = std::mem::replace(&mut self.lifecycle, RuntimeActorLifecycle::Running);
            let RuntimeActorLifecycle::Draining { drained } = lifecycle else {
                unreachable!("checked draining lifecycle before replacement");
            };
            self.lifecycle = RuntimeActorLifecycle::Drained;
            let _ = drained.send(());
        }
        Ok(!self.commands_open)
    }

    async fn write(&mut self, output: RuntimeOutputDraft) -> Result<(), RuntimeActorError> {
        if self.next_sequence == 0 || self.next_sequence > MAX_SAFE_SEQUENCE {
            return Err(RuntimeActorError::SequenceExhausted);
        }
        let envelope = Envelope {
            protocol_version: PROTOCOL_VERSION,
            message_id: Uuid::new_v4(),
            message_type: output.message_type,
            name: output.name,
            sent_at: output.sent_at,
            correlation_id: output.correlation_id,
            run_id: output.run_id,
            sequence: self.next_sequence,
            payload: output.payload,
        };
        let bytes = serde_json::to_vec(&envelope)?;
        self.writer.write_all(&bytes).await?;
        self.writer.write_all(b"\n").await?;
        self.writer.flush().await?;
        self.next_sequence = self
            .next_sequence
            .checked_add(1)
            .ok_or(RuntimeActorError::SequenceExhausted)?;
        Ok(())
    }
}

impl RuntimeActorHandle {
    pub async fn emit(&self, output: RuntimeOutputDraft) -> Result<(), RuntimeActorError> {
        self.commands
            .send(RuntimeActorCommand::Emit(output))
            .await
            .map_err(|_| RuntimeActorError::Closed)
    }

    pub async fn start_task(
        &self,
        key: RuntimeTaskKey,
        accepted: RuntimeOutputDraft,
        failure: RuntimeOutputDraft,
        task: impl FnOnce(watch::Receiver<bool>) -> RuntimeTask,
    ) -> Result<(), RuntimeActorError> {
        let (cancellation, receiver) = watch::channel(false);
        let (acknowledged, response) = oneshot::channel();
        self.commands
            .send(RuntimeActorCommand::StartTask {
                key,
                accepted: Some(accepted),
                failure,
                cancellation,
                task: task(receiver),
                acknowledged,
            })
            .await
            .map_err(|_| RuntimeActorError::Closed)?;
        response.await.map_err(|_| RuntimeActorError::Closed)?
    }

    pub async fn start_streaming_task(
        &self,
        key: RuntimeTaskKey,
        accepted: RuntimeOutputDraft,
        failure: RuntimeOutputDraft,
        task: impl FnOnce(watch::Receiver<bool>, RuntimeTaskProgressSender) -> RuntimeTask,
    ) -> Result<(), RuntimeActorError> {
        let progress = RuntimeTaskProgressSender {
            key,
            sender: self.progress.clone(),
        };
        self.start_task(key, accepted, failure, move |cancellation| {
            task(cancellation, progress)
        })
        .await
    }

    pub async fn start_silent_streaming_task(
        &self,
        key: RuntimeTaskKey,
        failure: RuntimeOutputDraft,
        task: impl FnOnce(watch::Receiver<bool>, RuntimeTaskProgressSender) -> RuntimeTask,
    ) -> Result<(), RuntimeActorError> {
        let (cancellation, receiver) = watch::channel(false);
        let (acknowledged, response) = oneshot::channel();
        let progress = RuntimeTaskProgressSender {
            key,
            sender: self.progress.clone(),
        };
        self.commands
            .send(RuntimeActorCommand::StartTask {
                key,
                accepted: None,
                failure,
                cancellation,
                task: task(receiver, progress),
                acknowledged,
            })
            .await
            .map_err(|_| RuntimeActorError::Closed)?;
        response.await.map_err(|_| RuntimeActorError::Closed)?
    }

    pub async fn cancel_run(&self, run_id: Uuid) -> Result<(), RuntimeActorError> {
        self.commands
            .send(RuntimeActorCommand::CancelRun(run_id))
            .await
            .map_err(|_| RuntimeActorError::Closed)
    }

    pub async fn active_run_tasks(
        &self,
        run_id: Uuid,
    ) -> Result<Vec<RuntimeTaskKey>, RuntimeActorError> {
        let (reply, response) = oneshot::channel();
        self.commands
            .send(RuntimeActorCommand::ActiveRunTasks { run_id, reply })
            .await
            .map_err(|_| RuntimeActorError::Closed)?;
        response.await.map_err(|_| RuntimeActorError::Closed)
    }

    pub async fn begin_drain(
        &self,
        stopped: RuntimeOutputDraft,
    ) -> Result<RuntimeDrain, RuntimeActorError> {
        let (begun, response) = oneshot::channel();
        let (drained, completion) = oneshot::channel();
        self.commands
            .send(RuntimeActorCommand::BeginDrain { begun, drained })
            .await
            .map_err(|_| RuntimeActorError::Closed)?;
        response.await.map_err(|_| RuntimeActorError::Closed)??;
        Ok(RuntimeDrain {
            commands: self.commands.clone(),
            stopped,
            drained: completion,
        })
    }

    pub async fn shutdown(&self, output: RuntimeOutputDraft) -> Result<(), RuntimeActorError> {
        self.begin_drain(output).await?.finish_stop().await
    }
}

impl RuntimeDrain {
    pub async fn finish_stop(self) -> Result<(), RuntimeActorError> {
        self.drained.await.map_err(|_| RuntimeActorError::Closed)?;
        let (finished, completion) = oneshot::channel();
        self.commands
            .send(RuntimeActorCommand::FinishStop {
                stopped: self.stopped,
                finished,
            })
            .await
            .map_err(|_| RuntimeActorError::Closed)?;
        completion.await.map_err(|_| RuntimeActorError::Closed)
    }
}

impl RuntimeTaskProgressSender {
    pub async fn emit(&self, output: RuntimeOutputDraft) -> Result<(), RuntimeActorError> {
        let (acknowledged, response) = oneshot::channel();
        self.sender
            .send(RuntimeTaskProgress {
                key: self.key,
                output,
                acknowledged,
            })
            .await
            .map_err(|_| RuntimeActorError::Closed)?;
        response.await.map_err(|_| RuntimeActorError::Closed)
    }
}

#[derive(Debug, Error)]
pub enum RuntimeActorError {
    #[error("Runtime Actor mailbox is closed")]
    Closed,
    #[error("Runtime Actor is draining and rejects new tasks")]
    Draining,
    #[error("Runtime Actor is already draining")]
    AlreadyDraining,
    #[error("Runtime Actor cannot stop before all accepted tasks are drained")]
    NotDrained,
    #[error("Runtime Actor output sequence is exhausted")]
    SequenceExhausted,
    #[error("Runtime Actor task set returned no task")]
    TaskSetEmpty,
    #[error("Runtime Actor task failed: {0}")]
    TaskJoin(tokio::task::JoinError),
    #[error(transparent)]
    Io(#[from] std::io::Error),
    #[error(transparent)]
    Serialize(#[from] serde_json::Error),
}
