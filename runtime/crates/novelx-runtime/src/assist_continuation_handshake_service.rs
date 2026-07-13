use std::collections::BTreeMap;

use novelx_protocol::{
    ProviderInferenceContinuationAcknowledge, ProviderInferenceContinuationProposal,
};
use thiserror::Error;
use uuid::Uuid;

/// Move-only proof that the Host acknowledged one exact persisted Assist continuation.
///
/// Callers cannot construct this proof directly.
///
/// ```compile_fail
/// use novelx_runtime::assist_continuation_handshake_service::AssistContinuationAckProof;
/// let _forged = AssistContinuationAckProof {};
/// ```
pub struct AssistContinuationAckProof {
    continuation_id: Uuid,
    continuation_identity_sha256: String,
}

impl AssistContinuationAckProof {
    pub fn continuation_id(&self) -> Uuid {
        self.continuation_id
    }

    pub fn continuation_identity_sha256(&self) -> &str {
        &self.continuation_identity_sha256
    }
}

enum PendingHandshake {
    Proposed(ProviderInferenceContinuationProposal),
    Acknowledged(ProviderInferenceContinuationProposal),
}

pub enum AssistContinuationAcknowledgement {
    Accepted {
        proposal: ProviderInferenceContinuationProposal,
        proof: AssistContinuationAckProof,
    },
    Duplicate {
        proposal: ProviderInferenceContinuationProposal,
    },
}

#[derive(Default)]
pub struct AssistContinuationHandshakeService {
    pending: BTreeMap<Uuid, PendingHandshake>,
}

impl AssistContinuationHandshakeService {
    pub fn register(
        &mut self,
        proposal: ProviderInferenceContinuationProposal,
    ) -> Result<(), AssistContinuationHandshakeError> {
        if proposal.continuation_id != proposal.continuation_inference_identity.inference_id {
            return Err(AssistContinuationHandshakeError::IdentityInvalid);
        }
        match self.pending.get(&proposal.continuation_id) {
            None => {
                self.pending.insert(
                    proposal.continuation_id,
                    PendingHandshake::Proposed(proposal),
                );
                Ok(())
            }
            Some(
                PendingHandshake::Proposed(existing) | PendingHandshake::Acknowledged(existing),
            ) if existing == &proposal => Ok(()),
            Some(_) => Err(AssistContinuationHandshakeError::ProposalConflict),
        }
    }

    pub fn acknowledge(
        &mut self,
        run_id: Uuid,
        acknowledgement: &ProviderInferenceContinuationAcknowledge,
    ) -> Result<AssistContinuationAcknowledgement, AssistContinuationHandshakeError> {
        let state = self
            .pending
            .get_mut(&acknowledgement.continuation_id)
            .ok_or(AssistContinuationHandshakeError::ProposalMissing)?;
        let already_acknowledged = matches!(state, PendingHandshake::Acknowledged(_));
        let proposal = match state {
            PendingHandshake::Proposed(proposal) | PendingHandshake::Acknowledged(proposal) => {
                proposal.clone()
            }
        };
        if proposal.run_id != run_id
            || proposal.continuation_identity_sha256 != acknowledgement.continuation_identity_sha256
            || proposal.parent_inference_identity != acknowledgement.parent_inference_identity
            || proposal.authorization_evidence != acknowledgement.authorization_evidence
        {
            return Err(AssistContinuationHandshakeError::EvidenceConflict);
        }
        if already_acknowledged {
            return Ok(AssistContinuationAcknowledgement::Duplicate { proposal });
        }
        *state = PendingHandshake::Acknowledged(proposal.clone());
        Ok(AssistContinuationAcknowledgement::Accepted {
            proof: AssistContinuationAckProof {
                continuation_id: proposal.continuation_id,
                continuation_identity_sha256: proposal.continuation_identity_sha256.clone(),
            },
            proposal,
        })
    }
}

#[derive(Debug, Error)]
pub enum AssistContinuationHandshakeError {
    #[error("Assist continuation identity is invalid")]
    IdentityInvalid,
    #[error("Assist continuation proposal conflicts with the registered proposal")]
    ProposalConflict,
    #[error("Assist continuation proposal is not pending")]
    ProposalMissing,
    #[error("Assist continuation acknowledgement evidence does not match the proposal")]
    EvidenceConflict,
}
