use novelx_protocol::ProviderRunIdentity;
use novelx_runtime::provider_gateway::{
    ProviderApiFlavor, ProviderAuthScheme, ProviderCapabilitySource, ProviderConfig,
    ProviderGateway, ProviderGatewayError, ProviderInputCapability, ProviderRegistry,
    ProviderRetryPolicy, provider_config_sha256,
};

const EXPECTED_CANONICAL_HASH: &str =
    "bc9267f85e52b4ac2945b81966aa9a4cc7f513642cfa8f0057f7fc35b90586c8";

#[test]
fn canonical_hash_matches_the_typescript_sorted_json_contract() {
    assert_eq!(
        provider_config_sha256(&config()).unwrap(),
        EXPECTED_CANONICAL_HASH
    );
}

#[test]
fn binds_a_zeroizing_credential_and_resolves_only_the_exact_run_identity() {
    let mut registry = ProviderRegistry::default();
    let receipt = registry
        .bind(
            config(),
            EXPECTED_CANONICAL_HASH,
            "test-secret-key".to_owned(),
        )
        .unwrap();
    assert_eq!(receipt.config_sha256, EXPECTED_CANONICAL_HASH);
    assert!(
        !serde_json::to_string(&receipt)
            .unwrap()
            .contains("test-secret-key")
    );

    let identity = ProviderRunIdentity {
        profile_id: "profile-1".to_owned(),
        provider_id: "deepseek".to_owned(),
        model_id: "deepseek-chat".to_owned(),
        config_sha256: EXPECTED_CANONICAL_HASH.to_owned(),
    };
    let provider = registry.resolve(&identity).unwrap();
    assert_eq!(provider.config(), &config());
    let mut changed = identity;
    changed.model_id = "deepseek-reasoner".to_owned();
    assert!(matches!(
        registry.resolve(&changed),
        Err(ProviderGatewayError::ProfileMismatch)
    ));
    assert!(registry.remove("profile-1"));
    assert!(matches!(
        registry.resolve(&changed),
        Err(ProviderGatewayError::CredentialRequired)
    ));
}

#[test]
fn rejects_hash_mismatch_insecure_remote_urls_and_noncanonical_capabilities() {
    let mut registry = ProviderRegistry::default();
    assert!(matches!(
        registry.bind(config(), &"0".repeat(64), "secret".to_owned()),
        Err(ProviderGatewayError::ConfigHashMismatch)
    ));

    let mut insecure = config();
    insecure.base_url = "http://provider.example/v1".to_owned();
    assert!(matches!(
        provider_config_sha256(&insecure).and_then(|hash| registry.bind(
            insecure,
            &hash,
            "secret".to_owned()
        )),
        Err(ProviderGatewayError::BaseUrlInvalid)
    ));

    let mut duplicate = config();
    duplicate.input = vec![ProviderInputCapability::Text, ProviderInputCapability::Text];
    assert!(matches!(
        provider_config_sha256(&duplicate).and_then(|hash| registry.bind(
            duplicate,
            &hash,
            "secret".to_owned()
        )),
        Err(ProviderGatewayError::InputCapabilitiesInvalid)
    ));
}

#[tokio::test]
async fn performs_a_real_minimal_http_ping_and_uses_provider_context_capability() {
    let (base_url, server) = spawn_http_server(vec![
        json_response(200, r#"{"data":[{"id":"deepseek-chat","context_window":1000000}]}"#),
        json_response(200, r#"{"model":"deepseek-chat","choices":[{"message":{"role":"assistant","content":"pong"}}]}"#),
    ])
    .await;
    let mut config = config();
    config.base_url = base_url;
    config.context_window = 128_000;
    let hash = provider_config_sha256(&config).unwrap();
    let mut registry = ProviderRegistry::default();
    registry.bind(config, &hash, "test-key".to_owned()).unwrap();
    let identity = ProviderRunIdentity {
        profile_id: "profile-1".to_owned(),
        provider_id: "deepseek".to_owned(),
        model_id: "deepseek-chat".to_owned(),
        config_sha256: hash,
    };

    let receipt = ProviderGateway::new()
        .unwrap()
        .test_connection(registry.resolve(&identity).unwrap())
        .await
        .unwrap();

    assert_eq!(receipt.context_window, 1_000_000);
    assert_eq!(
        receipt.context_window_source,
        ProviderCapabilitySource::Provider
    );
    assert_eq!(receipt.actual_model_id, "deepseek-chat");
    server.await.unwrap();
}

#[tokio::test]
async fn falls_back_to_configured_capability_when_models_endpoint_is_unavailable() {
    let (base_url, server) = spawn_http_server(vec![
        json_response(404, r#"{"error":"not supported"}"#),
        json_response(200, r#"{"model":"deepseek-chat","choices":[{"message":{"role":"assistant","content":"pong"}}]}"#),
    ])
    .await;
    let mut config = config();
    config.base_url = base_url;
    let hash = provider_config_sha256(&config).unwrap();
    let mut registry = ProviderRegistry::default();
    registry.bind(config, &hash, "test-key".to_owned()).unwrap();
    let identity = ProviderRunIdentity {
        profile_id: "profile-1".to_owned(),
        provider_id: "deepseek".to_owned(),
        model_id: "deepseek-chat".to_owned(),
        config_sha256: hash,
    };

    let receipt = ProviderGateway::new()
        .unwrap()
        .test_connection(registry.resolve(&identity).unwrap())
        .await
        .unwrap();

    assert_eq!(receipt.context_window, 1_000_000);
    assert_eq!(
        receipt.context_window_source,
        ProviderCapabilitySource::Configured
    );
    server.await.unwrap();
}

async fn spawn_http_server(responses: Vec<String>) -> (String, tokio::task::JoinHandle<()>) {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move {
        for response in responses {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut request = vec![0_u8; 16_384];
            let _ = socket.read(&mut request).await.unwrap();
            socket.write_all(response.as_bytes()).await.unwrap();
            socket.shutdown().await.unwrap();
        }
    });
    (format!("http://{address}/v1"), server)
}

fn json_response(status: u16, body: &str) -> String {
    let reason = match status {
        200 => "OK",
        404 => "Not Found",
        _ => "Error",
    };
    format!(
        "HTTP/1.1 {status} {reason}\r\nContent-Type: application/json; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    )
}

fn config() -> ProviderConfig {
    ProviderConfig {
        schema_version: 1,
        profile_id: "profile-1".to_owned(),
        provider_id: "deepseek".to_owned(),
        display_name: "DeepSeek".to_owned(),
        base_url: "https://api.deepseek.com/v1".to_owned(),
        model_id: "deepseek-chat".to_owned(),
        api_flavor: ProviderApiFlavor::OpenAiChatCompletions,
        auth_scheme: ProviderAuthScheme::Bearer,
        context_window: 1_000_000,
        max_tokens: None,
        reasoning: false,
        input: vec![ProviderInputCapability::Text],
        request_timeout_ms: 30_000,
        total_deadline_ms: 120_000,
        retry_policy: ProviderRetryPolicy {
            max_attempts: 3,
            max_total_delay_ms: 30_000,
        },
    }
}
