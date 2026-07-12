use std::collections::BTreeMap;

use novelx_protocol::ProviderRunIdentity;
use secrecy::{ExposeSecret, SecretString};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use thiserror::Error;
use url::Url;

const MAX_PROVIDER_RESPONSE_BYTES: usize = 1_048_576;

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
    providers: BTreeMap<String, BoundProvider>,
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
        self.providers.insert(profile_id, bound);
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
        Ok(provider)
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
                return Err(ProviderGatewayError::AuthenticationRejected);
            }
            Ok(response) if response.status() == reqwest::StatusCode::TOO_MANY_REQUESTS => {
                return Err(ProviderGatewayError::RateLimited);
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
        reqwest::StatusCode::UNAUTHORIZED | reqwest::StatusCode::FORBIDDEN => {
            Err(ProviderGatewayError::AuthenticationRejected)
        }
        reqwest::StatusCode::TOO_MANY_REQUESTS => Err(ProviderGatewayError::RateLimited),
        status if status.is_redirection() => Err(ProviderGatewayError::RedirectRejected),
        status => Err(ProviderGatewayError::HttpRejected(status.as_u16())),
    }
}

#[derive(Debug, Error)]
pub enum ProviderGatewayError {
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
    #[error("Provider configuration serialization failed: {0}")]
    Serialize(serde_json::Error),
    #[error("Provider HTTP client could not be created: {0}")]
    ClientBuild(reqwest::Error),
    #[error("Provider authentication was rejected")]
    AuthenticationRejected,
    #[error("Provider rate limit was reached")]
    RateLimited,
    #[error("Provider request timed out")]
    Timeout,
    #[error("Provider connection failed")]
    ConnectionFailed,
    #[error("Provider request failed")]
    RequestFailed,
    #[error("Provider redirect was rejected")]
    RedirectRejected,
    #[error("Provider returned HTTP {0}")]
    HttpRejected(u16),
    #[error("Provider model was not found")]
    ModelNotFound,
    #[error("Provider response was malformed")]
    ResponseMalformed,
    #[error("Provider response exceeded the size limit")]
    ResponseTooLarge,
}
