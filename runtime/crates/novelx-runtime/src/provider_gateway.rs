use std::collections::{BTreeMap, BTreeSet};
use std::sync::Arc;

use novelx_protocol::{ContextCompilationReceipt, ProviderRunIdentity};
use secrecy::{ExposeSecret, SecretString};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use thiserror::Error;
use tokio::sync::watch;
use url::Url;
use uuid::Uuid;

const MAX_PROVIDER_RESPONSE_BYTES: usize = 1_048_576;

#[derive(Clone, Copy, Eq, PartialEq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SensitiveMessageType {
    SensitiveCommand,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProviderBindSensitiveEnvelope {
    pub protocol_version: u16,
    pub message_id: Uuid,
    pub message_type: SensitiveMessageType,
    pub name: String,
    pub sent_at: String,
    pub correlation_id: Option<Uuid>,
    pub run_id: Option<Uuid>,
    pub sequence: u64,
    pub payload: ProviderBindSensitivePayload,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProviderBindSensitivePayload {
    pub config: ProviderConfig,
    pub config_sha256: String,
    pub credential: String,
}

impl ProviderBindSensitiveEnvelope {
    pub fn validate(&self, expected_sequence: u64) -> Result<(), ProviderGatewayError> {
        if self.protocol_version != novelx_protocol::PROTOCOL_VERSION
            || self.message_type != SensitiveMessageType::SensitiveCommand
            || self.name != "provider.bind"
            || self.correlation_id.is_some()
            || self.run_id.is_some()
            || self.sequence != expected_sequence
            || self.sent_at.trim().is_empty()
        {
            return Err(ProviderGatewayError::SensitiveProtocolInvalid);
        }
        Ok(())
    }
}

#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProviderInputCapability {
    Text,
    Image,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProviderApiFlavor {
    OpenAiChatCompletions,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProviderAuthScheme {
    Bearer,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProviderRetryPolicy {
    pub max_attempts: u16,
    pub max_total_delay_ms: u64,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProviderConfig {
    pub schema_version: u16,
    pub profile_id: String,
    pub provider_id: String,
    pub display_name: String,
    pub base_url: String,
    pub model_id: String,
    pub api_flavor: ProviderApiFlavor,
    pub auth_scheme: ProviderAuthScheme,
    pub context_window: u64,
    pub max_tokens: Option<u64>,
    pub reasoning: bool,
    pub input: Vec<ProviderInputCapability>,
    pub request_timeout_ms: u64,
    pub total_deadline_ms: u64,
    pub retry_policy: ProviderRetryPolicy,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProviderBindingReceipt {
    pub profile_id: String,
    pub provider_id: String,
    pub model_id: String,
    pub config_sha256: String,
    pub context_window: u64,
    pub max_tokens: Option<u64>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProviderCapabilitySource {
    Provider,
    Configured,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProviderConnectionReceipt {
    pub profile_id: String,
    pub provider_id: String,
    pub requested_model_id: String,
    pub actual_model_id: String,
    pub config_sha256: String,
    pub context_window: u64,
    pub context_window_source: ProviderCapabilitySource,
    pub latency_ms: u64,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProviderInferenceRole {
    System,
    User,
    Assistant,
    Tool,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProviderInferenceMessage {
    pub role: ProviderInferenceRole,
    pub content: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty", rename = "tool_calls")]
    pub tool_calls: Vec<ProviderInferenceToolCall>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        rename = "tool_call_id"
    )]
    pub tool_call_id: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProviderInferenceToolCall {
    pub id: String,
    #[serde(rename = "type")]
    pub call_type: String,
    pub function: ProviderInferenceFunctionCall,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProviderInferenceFunctionCall {
    pub name: String,
    pub arguments: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProviderInferenceRequest {
    pub compilation: ContextCompilationReceipt,
    pub messages: Vec<ProviderInferenceMessage>,
    pub tools: Vec<Value>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProviderUsageReceipt {
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub total_tokens: u64,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProviderInferenceReceipt {
    pub context_compilation_id: Uuid,
    pub canonical_context_sha256: String,
    pub requested_model_id: String,
    pub actual_model_id: String,
    pub response_id_sha256: String,
    pub response_body_sha256: String,
    pub finish_reason: String,
    pub usage: ProviderUsageReceipt,
    pub provider_request_count: u64,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProviderToolCall {
    pub id: String,
    pub name: String,
    pub arguments: Value,
    pub arguments_sha256: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProviderInferenceOutcome {
    pub text: Option<String>,
    pub tool_calls: Vec<ProviderToolCall>,
    pub receipt: ProviderInferenceReceipt,
}

pub struct PreparedProviderInference {
    request: ProviderInferenceRequest,
    transport_payload: Vec<u8>,
    transport_payload_sha256: String,
}

impl PreparedProviderInference {
    pub fn transport_payload_sha256(&self) -> &str {
        &self.transport_payload_sha256
    }

    pub fn transport_payload_bytes(&self) -> u64 {
        u64::try_from(self.transport_payload.len()).unwrap_or(u64::MAX)
    }

    pub const fn compilation(&self) -> &ContextCompilationReceipt {
        &self.request.compilation
    }
}

pub struct BoundProvider {
    config: ProviderConfig,
    config_sha256: String,
    credential: SecretString,
}

impl BoundProvider {
    pub const fn config(&self) -> &ProviderConfig {
        &self.config
    }

    pub fn config_sha256(&self) -> &str {
        &self.config_sha256
    }

    fn receipt(&self) -> ProviderBindingReceipt {
        ProviderBindingReceipt {
            profile_id: self.config.profile_id.clone(),
            provider_id: self.config.provider_id.clone(),
            model_id: self.config.model_id.clone(),
            config_sha256: self.config_sha256.clone(),
            context_window: self.config.context_window,
            max_tokens: self.config.max_tokens,
        }
    }
}

#[derive(Default)]
pub struct ProviderRegistry {
    providers: BTreeMap<String, Arc<BoundProvider>>,
}

impl ProviderRegistry {
    pub fn bind(
        &mut self,
        config: ProviderConfig,
        declared_config_sha256: &str,
        credential: String,
    ) -> Result<ProviderBindingReceipt, ProviderGatewayError> {
        validate_config(&config)?;
        if credential.trim().is_empty() || credential.len() > 8_192 {
            return Err(ProviderGatewayError::CredentialInvalid);
        }
        let actual_hash = provider_config_sha256(&config)?;
        if declared_config_sha256 != actual_hash {
            return Err(ProviderGatewayError::ConfigHashMismatch);
        }
        let profile_id = config.profile_id.clone();
        let bound = BoundProvider {
            config,
            config_sha256: actual_hash,
            credential: SecretString::from(credential),
        };
        let receipt = bound.receipt();
        self.providers.insert(profile_id, Arc::new(bound));
        Ok(receipt)
    }

    pub fn resolve(
        &self,
        identity: &ProviderRunIdentity,
    ) -> Result<&BoundProvider, ProviderGatewayError> {
        let provider = self
            .providers
            .get(&identity.profile_id)
            .ok_or(ProviderGatewayError::CredentialRequired)?;
        if provider.config.provider_id != identity.provider_id
            || provider.config.model_id != identity.model_id
            || provider.config_sha256 != identity.config_sha256
        {
            return Err(ProviderGatewayError::ProfileMismatch);
        }
        Ok(provider.as_ref())
    }

    pub fn resolve_owned(
        &self,
        identity: &ProviderRunIdentity,
    ) -> Result<Arc<BoundProvider>, ProviderGatewayError> {
        self.resolve(identity)?;
        self.providers
            .get(&identity.profile_id)
            .cloned()
            .ok_or(ProviderGatewayError::CredentialRequired)
    }

    pub fn remove(&mut self, profile_id: &str) -> bool {
        self.providers.remove(profile_id).is_some()
    }

    pub fn clear(&mut self) {
        self.providers.clear();
    }
}

pub struct ProviderGateway {
    client: reqwest::Client,
}

impl ProviderGateway {
    pub fn new() -> Result<Self, ProviderGatewayError> {
        let client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .map_err(ProviderGatewayError::ClientBuild)?;
        Ok(Self { client })
    }

    pub async fn test_connection(
        &self,
        provider: &BoundProvider,
    ) -> Result<ProviderConnectionReceipt, ProviderGatewayError> {
        let started = std::time::Instant::now();
        let deadline = std::time::Duration::from_millis(provider.config.total_deadline_ms);
        tokio::time::timeout(deadline, self.test_connection_within_deadline(provider))
            .await
            .map_err(|_| ProviderGatewayError::Timeout)?
            .map(|mut receipt| {
                receipt.latency_ms =
                    u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX);
                receipt
            })
    }

    pub async fn infer(
        &self,
        provider: &BoundProvider,
        request: ProviderInferenceRequest,
    ) -> Result<ProviderInferenceOutcome, ProviderGatewayError> {
        let prepared = self.prepare_inference(provider, request)?;
        self.infer_prepared(provider, prepared).await
    }

    pub fn prepare_inference(
        &self,
        provider: &BoundProvider,
        request: ProviderInferenceRequest,
    ) -> Result<PreparedProviderInference, ProviderGatewayError> {
        validate_inference_request(provider, &request)?;
        let transport_payload = serde_json::to_vec(&inference_body(provider, &request)?)
            .map_err(ProviderGatewayError::Serialize)?;
        let transport_payload_sha256 = format!("{:x}", Sha256::digest(&transport_payload));
        Ok(PreparedProviderInference {
            request,
            transport_payload,
            transport_payload_sha256,
        })
    }

    pub async fn infer_prepared(
        &self,
        provider: &BoundProvider,
        prepared: PreparedProviderInference,
    ) -> Result<ProviderInferenceOutcome, ProviderGatewayError> {
        validate_inference_request(provider, &prepared.request)?;
        let deadline = std::time::Duration::from_millis(provider.config.total_deadline_ms);
        tokio::time::timeout(deadline, self.infer_within_deadline(provider, prepared))
            .await
            .map_err(|_| ProviderGatewayError::Timeout)?
    }

    pub async fn infer_prepared_cancellable(
        &self,
        provider: &BoundProvider,
        prepared: PreparedProviderInference,
        cancellation: &mut watch::Receiver<bool>,
    ) -> Result<ProviderInferenceOutcome, ProviderGatewayError> {
        if *cancellation.borrow() {
            return Err(ProviderGatewayError::Cancelled);
        }
        let inference = self.infer_prepared(provider, prepared);
        tokio::pin!(inference);
        tokio::select! {
            result = &mut inference => result,
            changed = cancellation.changed() => {
                if changed.is_ok() && *cancellation.borrow() {
                    Err(ProviderGatewayError::Cancelled)
                } else {
                    inference.await
                }
            }
        }
    }

    async fn infer_within_deadline(
        &self,
        provider: &BoundProvider,
        prepared: PreparedProviderInference,
    ) -> Result<ProviderInferenceOutcome, ProviderGatewayError> {
        let timeout = std::time::Duration::from_millis(provider.config.request_timeout_ms);
        let url = endpoint_url(&provider.config.base_url, "chat/completions")?;
        let response = self
            .client
            .post(url)
            .bearer_auth(provider.credential.expose_secret())
            .timeout(timeout)
            .header(reqwest::header::CONTENT_TYPE, "application/json")
            .body(prepared.transport_payload)
            .send()
            .await
            .map_err(classify_transport_error)?;
        classify_status(response.status())?;
        let payload = read_json_response(response).await?;
        parse_inference_response(provider, &prepared.request.compilation, &payload)
    }

    async fn test_connection_within_deadline(
        &self,
        provider: &BoundProvider,
    ) -> Result<ProviderConnectionReceipt, ProviderGatewayError> {
        let timeout = std::time::Duration::from_millis(provider.config.request_timeout_ms);
        let models_url = endpoint_url(&provider.config.base_url, "models")?;
        let models_response = self
            .client
            .get(models_url)
            .bearer_auth(provider.credential.expose_secret())
            .timeout(timeout)
            .send()
            .await;
        let discovered_context = match models_response {
            Ok(response) if response.status().is_success() => {
                let payload = read_json_response(response).await?;
                find_model_context(&payload, &provider.config.model_id)?
            }
            Ok(response)
                if response.status() == reqwest::StatusCode::UNAUTHORIZED
                    || response.status() == reqwest::StatusCode::FORBIDDEN =>
            {
                return Err(ProviderGatewayError::AuthenticationRejected(
                    response.status().as_u16(),
                ));
            }
            Ok(response) if response.status() == reqwest::StatusCode::TOO_MANY_REQUESTS => {
                return Err(ProviderGatewayError::RateLimited(
                    response.status().as_u16(),
                ));
            }
            Ok(_) => None,
            Err(error) if error.is_timeout() => return Err(ProviderGatewayError::Timeout),
            Err(_) => None,
        };

        let ping_url = endpoint_url(&provider.config.base_url, "chat/completions")?;
        let response = self
            .client
            .post(ping_url)
            .bearer_auth(provider.credential.expose_secret())
            .timeout(timeout)
            .json(&serde_json::json!({
                "model": provider.config.model_id,
                "messages": [{ "role": "user", "content": "ping" }],
                "max_tokens": 8,
                "stream": false,
            }))
            .send()
            .await
            .map_err(classify_transport_error)?;
        classify_status(response.status())?;
        let payload = read_json_response(response).await?;
        let actual_model_id = validate_ping_payload(&payload)?;
        Ok(ProviderConnectionReceipt {
            profile_id: provider.config.profile_id.clone(),
            provider_id: provider.config.provider_id.clone(),
            requested_model_id: provider.config.model_id.clone(),
            actual_model_id,
            config_sha256: provider.config_sha256.clone(),
            context_window: discovered_context.unwrap_or(provider.config.context_window),
            context_window_source: if discovered_context.is_some() {
                ProviderCapabilitySource::Provider
            } else {
                ProviderCapabilitySource::Configured
            },
            latency_ms: 0,
        })
    }
}

fn inference_body(
    provider: &BoundProvider,
    request: &ProviderInferenceRequest,
) -> Result<Value, ProviderGatewayError> {
    let mut body = serde_json::Map::from_iter([
        (
            "model".to_owned(),
            Value::String(provider.config.model_id.clone()),
        ),
        (
            "messages".to_owned(),
            serde_json::to_value(&request.messages).map_err(ProviderGatewayError::Serialize)?,
        ),
        ("stream".to_owned(), Value::Bool(false)),
        (
            "max_tokens".to_owned(),
            Value::from(request.compilation.output_reserve_tokens),
        ),
    ]);
    if !request.tools.is_empty() {
        body.insert("tools".to_owned(), Value::Array(request.tools.clone()));
    }
    Ok(Value::Object(body))
}

fn validate_inference_request(
    provider: &BoundProvider,
    request: &ProviderInferenceRequest,
) -> Result<(), ProviderGatewayError> {
    let receipt = &request.compilation;
    if !receipt.accepted
        || request.messages.is_empty()
        || receipt.context_window != provider.config.context_window
        || receipt.output_reserve_tokens == 0
        || receipt.output_reserve_tokens > provider.config.context_window
        || receipt.tokenizer.provider_id.as_deref() != Some(provider.config.provider_id.as_str())
        || receipt.tokenizer.model_id.as_deref() != Some(provider.config.model_id.as_str())
        || !is_sha256(&receipt.canonical_context_sha256)
    {
        return Err(ProviderGatewayError::ContextReceiptMismatch);
    }
    if provider
        .config
        .max_tokens
        .is_some_and(|maximum| receipt.output_reserve_tokens > maximum)
    {
        return Err(ProviderGatewayError::ContextReceiptMismatch);
    }
    validate_message_sequence(&request.messages)?;
    Ok(())
}

fn validate_message_sequence(
    messages: &[ProviderInferenceMessage],
) -> Result<(), ProviderGatewayError> {
    let mut pending = std::collections::HashSet::new();
    let mut seen = std::collections::HashSet::new();
    for message in messages {
        if !pending.is_empty() && message.role != ProviderInferenceRole::Tool {
            return Err(ProviderGatewayError::ContextReceiptMismatch);
        }
        match message.role {
            ProviderInferenceRole::Assistant if !message.tool_calls.is_empty() => {
                if message.tool_call_id.is_some() {
                    return Err(ProviderGatewayError::ContextReceiptMismatch);
                }
                for call in &message.tool_calls {
                    if call.id.trim().is_empty()
                        || call.call_type != "function"
                        || call.function.name.trim().is_empty()
                        || serde_json::from_str::<Value>(&call.function.arguments).is_err()
                        || !seen.insert(call.id.as_str())
                        || !pending.insert(call.id.as_str())
                    {
                        return Err(ProviderGatewayError::ContextReceiptMismatch);
                    }
                }
            }
            ProviderInferenceRole::Tool => {
                if !message.tool_calls.is_empty() {
                    return Err(ProviderGatewayError::ContextReceiptMismatch);
                }
                let Some(call_id) = message.tool_call_id.as_deref() else {
                    return Err(ProviderGatewayError::ContextReceiptMismatch);
                };
                if !pending.remove(call_id) {
                    return Err(ProviderGatewayError::ContextReceiptMismatch);
                }
            }
            _ => {
                if !message.tool_calls.is_empty() || message.tool_call_id.is_some() {
                    return Err(ProviderGatewayError::ContextReceiptMismatch);
                }
            }
        }
    }
    if pending.is_empty() {
        Ok(())
    } else {
        Err(ProviderGatewayError::ContextReceiptMismatch)
    }
}

fn parse_inference_response(
    provider: &BoundProvider,
    compilation: &ContextCompilationReceipt,
    payload: &Value,
) -> Result<ProviderInferenceOutcome, ProviderGatewayError> {
    let response_body_sha256 = format!(
        "{:x}",
        Sha256::digest(serde_json::to_vec(payload).map_err(ProviderGatewayError::Serialize)?)
    );
    let response_id = payload
        .get("id")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or(ProviderGatewayError::ResponseMalformed)?;
    let actual_model_id = payload
        .get("model")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or(ProviderGatewayError::ResponseMalformed)?;
    if actual_model_id != provider.config.model_id {
        return Err(ProviderGatewayError::ResponseModelMismatch);
    }
    let choice = payload
        .get("choices")
        .and_then(Value::as_array)
        .and_then(|choices| choices.first())
        .ok_or(ProviderGatewayError::ResponseMalformed)?;
    let finish_reason = choice
        .get("finish_reason")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or(ProviderGatewayError::ResponseMalformed)?;
    if finish_reason == "length" {
        return Err(ProviderGatewayError::OutputIncomplete);
    }
    if finish_reason != "stop" && finish_reason != "tool_calls" {
        return Err(ProviderGatewayError::ResponseMalformed);
    }
    let message = choice
        .get("message")
        .and_then(Value::as_object)
        .ok_or(ProviderGatewayError::ResponseMalformed)?;
    let text = match message.get("content") {
        None | Some(Value::Null) => None,
        Some(Value::String(value)) if !value.trim().is_empty() => Some(value.clone()),
        _ => return Err(ProviderGatewayError::ResponseMalformed),
    };
    let tool_calls = parse_tool_calls(message.get("tool_calls"))?;
    match finish_reason {
        "stop" if text.is_some() && tool_calls.is_empty() => {}
        "tool_calls" if !tool_calls.is_empty() => {}
        _ => return Err(ProviderGatewayError::ResponseMalformed),
    }
    let usage = payload
        .get("usage")
        .and_then(Value::as_object)
        .ok_or(ProviderGatewayError::ResponseMalformed)?;
    let input_tokens = usage
        .get("prompt_tokens")
        .and_then(Value::as_u64)
        .ok_or(ProviderGatewayError::ResponseMalformed)?;
    let output_tokens = usage
        .get("completion_tokens")
        .and_then(Value::as_u64)
        .ok_or(ProviderGatewayError::ResponseMalformed)?;
    let total_tokens = usage
        .get("total_tokens")
        .and_then(Value::as_u64)
        .ok_or(ProviderGatewayError::ResponseMalformed)?;
    if input_tokens.saturating_add(output_tokens) != total_tokens {
        return Err(ProviderGatewayError::ResponseMalformed);
    }
    Ok(ProviderInferenceOutcome {
        text,
        tool_calls,
        receipt: ProviderInferenceReceipt {
            context_compilation_id: compilation.compilation_id,
            canonical_context_sha256: compilation.canonical_context_sha256.clone(),
            requested_model_id: provider.config.model_id.clone(),
            actual_model_id: actual_model_id.to_owned(),
            response_id_sha256: format!("{:x}", Sha256::digest(response_id.as_bytes())),
            response_body_sha256,
            finish_reason: finish_reason.to_owned(),
            usage: ProviderUsageReceipt {
                input_tokens,
                output_tokens,
                total_tokens,
            },
            provider_request_count: 1,
        },
    })
}

fn parse_tool_calls(value: Option<&Value>) -> Result<Vec<ProviderToolCall>, ProviderGatewayError> {
    let Some(value) = value else {
        return Ok(Vec::new());
    };
    let calls = value
        .as_array()
        .ok_or(ProviderGatewayError::ResponseMalformed)?;
    let mut ids = BTreeSet::new();
    let mut parsed = Vec::with_capacity(calls.len());
    for call in calls {
        let call = call
            .as_object()
            .ok_or(ProviderGatewayError::ResponseMalformed)?;
        if call.get("type").and_then(Value::as_str) != Some("function") {
            return Err(ProviderGatewayError::ResponseMalformed);
        }
        let id = call
            .get("id")
            .and_then(Value::as_str)
            .filter(|value| !value.trim().is_empty())
            .ok_or(ProviderGatewayError::ResponseMalformed)?
            .to_owned();
        if !ids.insert(id.clone()) {
            return Err(ProviderGatewayError::ResponseMalformed);
        }
        let function = call
            .get("function")
            .and_then(Value::as_object)
            .ok_or(ProviderGatewayError::ResponseMalformed)?;
        let name = function
            .get("name")
            .and_then(Value::as_str)
            .filter(|value| !value.trim().is_empty())
            .ok_or(ProviderGatewayError::ResponseMalformed)?
            .to_owned();
        let arguments_text = function
            .get("arguments")
            .and_then(Value::as_str)
            .ok_or(ProviderGatewayError::ResponseMalformed)?;
        let arguments: Value = serde_json::from_str(arguments_text)
            .map_err(|_| ProviderGatewayError::ResponseMalformed)?;
        if !arguments.is_object() {
            return Err(ProviderGatewayError::ResponseMalformed);
        }
        let canonical_arguments =
            serde_json::to_vec(&arguments).map_err(ProviderGatewayError::Serialize)?;
        parsed.push(ProviderToolCall {
            id,
            name,
            arguments,
            arguments_sha256: format!("{:x}", Sha256::digest(canonical_arguments)),
        });
    }
    Ok(parsed)
}

fn is_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

pub fn provider_config_sha256(config: &ProviderConfig) -> Result<String, ProviderGatewayError> {
    let value = serde_json::to_value(config).map_err(ProviderGatewayError::Serialize)?;
    let canonical =
        serde_json::to_string(&canonicalize(value)).map_err(ProviderGatewayError::Serialize)?;
    Ok(format!("{:x}", Sha256::digest(canonical.as_bytes())))
}

fn canonicalize(value: Value) -> Value {
    match value {
        Value::Array(values) => Value::Array(values.into_iter().map(canonicalize).collect()),
        Value::Object(values) => Value::Object(
            values
                .into_iter()
                .map(|(key, value)| (key, canonicalize(value)))
                .collect(),
        ),
        scalar => scalar,
    }
}

fn validate_config(config: &ProviderConfig) -> Result<(), ProviderGatewayError> {
    for (field, value) in [
        ("profileId", config.profile_id.as_str()),
        ("providerId", config.provider_id.as_str()),
        ("displayName", config.display_name.as_str()),
        ("modelId", config.model_id.as_str()),
    ] {
        if value.trim().is_empty() {
            return Err(ProviderGatewayError::EmptyField(field));
        }
    }
    if config.context_window == 0 || config.context_window > 10_000_000 {
        return Err(ProviderGatewayError::ContextWindowInvalid);
    }
    if config.schema_version != 1 {
        return Err(ProviderGatewayError::SchemaVersionUnsupported);
    }
    if config
        .max_tokens
        .is_some_and(|value| value == 0 || value > 1_000_000 || value > config.context_window)
    {
        return Err(ProviderGatewayError::MaxTokensInvalid);
    }
    if config.input.is_empty()
        || config.input.len() > 2
        || config.input.windows(2).any(|pair| pair[0] >= pair[1])
    {
        return Err(ProviderGatewayError::InputCapabilitiesInvalid);
    }
    if !(1_000..=300_000).contains(&config.request_timeout_ms)
        || config.total_deadline_ms < config.request_timeout_ms
        || config.total_deadline_ms > 900_000
        || !(1..=10).contains(&config.retry_policy.max_attempts)
        || config.retry_policy.max_total_delay_ms > config.total_deadline_ms
    {
        return Err(ProviderGatewayError::RequestPolicyInvalid);
    }
    let url = Url::parse(&config.base_url).map_err(|_| ProviderGatewayError::BaseUrlInvalid)?;
    if !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(ProviderGatewayError::BaseUrlInvalid);
    }
    let secure = url.scheme() == "https";
    let loopback =
        url.scheme() == "http" && matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "::1"));
    if !secure && !loopback {
        return Err(ProviderGatewayError::BaseUrlInvalid);
    }
    Ok(())
}

fn endpoint_url(base_url: &str, path: &str) -> Result<Url, ProviderGatewayError> {
    let normalized = if base_url.ends_with('/') {
        base_url.to_owned()
    } else {
        format!("{base_url}/")
    };
    Url::parse(&normalized)
        .and_then(|base| base.join(path))
        .map_err(|_| ProviderGatewayError::BaseUrlInvalid)
}

async fn read_json_response(response: reqwest::Response) -> Result<Value, ProviderGatewayError> {
    let content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default()
        .to_ascii_lowercase();
    if !content_type.starts_with("application/json") {
        return Err(ProviderGatewayError::ResponseMalformed);
    }
    let bytes = response.bytes().await.map_err(classify_transport_error)?;
    if bytes.len() > MAX_PROVIDER_RESPONSE_BYTES {
        return Err(ProviderGatewayError::ResponseTooLarge);
    }
    serde_json::from_slice(&bytes).map_err(|_| ProviderGatewayError::ResponseMalformed)
}

fn find_model_context(
    payload: &Value,
    model_id: &str,
) -> Result<Option<u64>, ProviderGatewayError> {
    let models = payload
        .get("data")
        .and_then(Value::as_array)
        .ok_or(ProviderGatewayError::ResponseMalformed)?;
    let model = models
        .iter()
        .find(|model| model.get("id").and_then(Value::as_str) == Some(model_id))
        .ok_or(ProviderGatewayError::ModelNotFound)?;
    Ok([
        "context_window",
        "contextWindow",
        "max_model_len",
        "max_context_length",
    ]
    .iter()
    .find_map(|field| model.get(field).and_then(Value::as_u64))
    .filter(|value| *value > 0 && *value <= 10_000_000))
}

fn validate_ping_payload(payload: &Value) -> Result<String, ProviderGatewayError> {
    let choice = payload
        .get("choices")
        .and_then(Value::as_array)
        .and_then(|choices| choices.first())
        .ok_or(ProviderGatewayError::ResponseMalformed)?;
    let message = choice
        .get("message")
        .and_then(Value::as_object)
        .ok_or(ProviderGatewayError::ResponseMalformed)?;
    let has_content = message
        .get("content")
        .and_then(Value::as_str)
        .is_some_and(|value| !value.trim().is_empty());
    let has_tool_calls = message
        .get("tool_calls")
        .and_then(Value::as_array)
        .is_some_and(|value| !value.is_empty());
    if !has_content && !has_tool_calls {
        return Err(ProviderGatewayError::ResponseMalformed);
    }
    payload
        .get("model")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .map(str::to_owned)
        .ok_or(ProviderGatewayError::ResponseMalformed)
}

fn classify_transport_error(error: reqwest::Error) -> ProviderGatewayError {
    if error.is_timeout() {
        ProviderGatewayError::Timeout
    } else if error.is_connect() {
        ProviderGatewayError::ConnectionFailed
    } else {
        ProviderGatewayError::RequestFailed
    }
}

fn classify_status(status: reqwest::StatusCode) -> Result<(), ProviderGatewayError> {
    match status {
        status if status.is_success() => Ok(()),
        reqwest::StatusCode::UNAUTHORIZED | reqwest::StatusCode::FORBIDDEN => Err(
            ProviderGatewayError::AuthenticationRejected(status.as_u16()),
        ),
        reqwest::StatusCode::TOO_MANY_REQUESTS => {
            Err(ProviderGatewayError::RateLimited(status.as_u16()))
        }
        status if status.is_redirection() => {
            Err(ProviderGatewayError::RedirectRejected(status.as_u16()))
        }
        status => Err(ProviderGatewayError::HttpRejected(status.as_u16())),
    }
}

#[derive(Debug, Error)]
pub enum ProviderGatewayError {
    #[error("Sensitive Provider protocol message is invalid")]
    SensitiveProtocolInvalid,
    #[error("Provider configuration schema version is unsupported")]
    SchemaVersionUnsupported,
    #[error("Provider field `{0}` must not be empty")]
    EmptyField(&'static str),
    #[error("Provider base URL is invalid")]
    BaseUrlInvalid,
    #[error("Provider context window is invalid")]
    ContextWindowInvalid,
    #[error("Provider max tokens is invalid")]
    MaxTokensInvalid,
    #[error("Provider input capabilities must be sorted, unique and non-empty")]
    InputCapabilitiesInvalid,
    #[error("Provider timeout or retry policy is invalid")]
    RequestPolicyInvalid,
    #[error("Provider credential is missing or invalid")]
    CredentialInvalid,
    #[error("Provider credential is not bound")]
    CredentialRequired,
    #[error("Provider configuration hash does not match")]
    ConfigHashMismatch,
    #[error("Provider profile does not match the Run pinned identity")]
    ProfileMismatch,
    #[error("Provider inference request does not match its Context Compilation receipt")]
    ContextReceiptMismatch,
    #[error("Provider configuration serialization failed: {0}")]
    Serialize(serde_json::Error),
    #[error("Provider HTTP client could not be created: {0}")]
    ClientBuild(reqwest::Error),
    #[error("Provider authentication was rejected")]
    AuthenticationRejected(u16),
    #[error("Provider rate limit was reached")]
    RateLimited(u16),
    #[error("Provider request timed out")]
    Timeout,
    #[error("Provider request was cancelled after dispatch")]
    Cancelled,
    #[error("Provider connection failed")]
    ConnectionFailed,
    #[error("Provider request failed")]
    RequestFailed,
    #[error("Provider redirect was rejected")]
    RedirectRejected(u16),
    #[error("Provider returned HTTP {0}")]
    HttpRejected(u16),
    #[error("Provider model was not found")]
    ModelNotFound,
    #[error("Provider response was malformed")]
    ResponseMalformed,
    #[error("Provider response model does not match the requested model")]
    ResponseModelMismatch,
    #[error("Provider output ended because the output token limit was reached")]
    OutputIncomplete,
    #[error("Provider response exceeded the size limit")]
    ResponseTooLarge,
}
