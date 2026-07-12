use novelx_protocol::{ProviderInferenceToolCall, ToolArtifactReceipt};
use sha2::{Digest, Sha256};
use thiserror::Error;
use uuid::Uuid;

use crate::artifact_store::{ArtifactStore, ArtifactStoreError};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MaterializedProviderToolCall {
    pub tool_call_id: Uuid,
    pub provider_tool_call_id: String,
    pub tool_name: String,
    pub arguments: ToolArtifactReceipt,
}

pub struct ProviderToolMaterializer<'a> {
    artifacts: &'a mut ArtifactStore,
}

impl<'a> ProviderToolMaterializer<'a> {
    pub fn new(artifacts: &'a mut ArtifactStore) -> Self {
        Self { artifacts }
    }

    pub fn materialize(
        &mut self,
        run_id: &str,
        invocation_id: &str,
        inference_id: &str,
        calls: &[ProviderInferenceToolCall],
    ) -> Result<Vec<MaterializedProviderToolCall>, ProviderToolMaterializerError> {
        if run_id.trim().is_empty()
            || invocation_id.trim().is_empty()
            || inference_id.trim().is_empty()
        {
            return Err(ProviderToolMaterializerError::IdentityInvalid);
        }
        calls
            .iter()
            .map(|call| self.materialize_one(run_id, invocation_id, inference_id, call))
            .collect()
    }

    fn materialize_one(
        &mut self,
        run_id: &str,
        invocation_id: &str,
        inference_id: &str,
        call: &ProviderInferenceToolCall,
    ) -> Result<MaterializedProviderToolCall, ProviderToolMaterializerError> {
        if call.id.trim().is_empty() || call.name.trim().is_empty() {
            return Err(ProviderToolMaterializerError::IdentityInvalid);
        }
        let canonical_arguments = serde_json::to_vec(&call.arguments)?;
        let actual_hash = format!("{:x}", Sha256::digest(&canonical_arguments));
        if actual_hash != call.arguments_sha256 {
            return Err(ProviderToolMaterializerError::ArgumentsHashMismatch);
        }
        let tool_call_id = stable_uuid(
            b"novelx.runtime-v2.tool-call.v1",
            run_id,
            invocation_id,
            inference_id,
            &call.id,
            &call.name,
            &actual_hash,
        );
        let artifact_id = stable_uuid(
            b"novelx.runtime-v2.tool-arguments.v1",
            run_id,
            invocation_id,
            inference_id,
            &call.id,
            &call.name,
            &actual_hash,
        );
        let stored = self
            .artifacts
            .put_json(artifact_id, run_id, &call.arguments)?;
        Ok(MaterializedProviderToolCall {
            tool_call_id,
            provider_tool_call_id: call.id.clone(),
            tool_name: call.name.clone(),
            arguments: stored.receipt,
        })
    }
}

fn stable_uuid(
    domain: &[u8],
    run_id: &str,
    invocation_id: &str,
    inference_id: &str,
    provider_tool_call_id: &str,
    tool_name: &str,
    arguments_sha256: &str,
) -> Uuid {
    let mut hasher = Sha256::new();
    for value in [
        domain,
        run_id.as_bytes(),
        invocation_id.as_bytes(),
        inference_id.as_bytes(),
        provider_tool_call_id.as_bytes(),
        tool_name.as_bytes(),
        arguments_sha256.as_bytes(),
    ] {
        hasher.update((value.len() as u64).to_be_bytes());
        hasher.update(value);
    }
    let digest = hasher.finalize();
    let mut bytes = [0_u8; 16];
    bytes.copy_from_slice(&digest[..16]);
    bytes[6] = (bytes[6] & 0x0f) | 0x50;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    Uuid::from_bytes(bytes)
}

#[derive(Debug, Error)]
pub enum ProviderToolMaterializerError {
    #[error("Provider tool call identity is invalid")]
    IdentityInvalid,
    #[error("Provider tool call arguments do not match their persisted SHA-256")]
    ArgumentsHashMismatch,
    #[error(transparent)]
    Artifact(#[from] ArtifactStoreError),
    #[error(transparent)]
    Json(#[from] serde_json::Error),
}
