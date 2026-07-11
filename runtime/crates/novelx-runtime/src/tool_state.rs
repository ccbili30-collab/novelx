use std::error::Error;
use std::fmt::{self, Display, Formatter};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ToolSideEffect {
    None,
    StagedWrite,
    ExternalEffect,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ToolAuthorization {
    Pending,
    Allowed,
    ApprovalRequired,
    Denied,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ToolState {
    Requested,
    Authorized,
    Running,
    Completed,
    Failed,
    Denied,
    Cancelled,
    TimedOut,
}

impl ToolState {
    pub const fn is_terminal(self) -> bool {
        matches!(
            self,
            Self::Completed | Self::Failed | Self::Denied | Self::Cancelled | Self::TimedOut
        )
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ToolOutcomeKnowledge {
    Known,
    Unknown,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ToolCallStateMachine {
    state: ToolState,
    authorization: ToolAuthorization,
    side_effect: ToolSideEffect,
    parallel_execution_allowed: bool,
}

impl ToolCallStateMachine {
    pub const fn new(side_effect: ToolSideEffect) -> Self {
        Self {
            state: ToolState::Requested,
            authorization: ToolAuthorization::Pending,
            side_effect,
            parallel_execution_allowed: false,
        }
    }

    pub const fn state(&self) -> ToolState {
        self.state
    }

    pub const fn authorization(&self) -> ToolAuthorization {
        self.authorization
    }

    pub const fn side_effect(&self) -> ToolSideEffect {
        self.side_effect
    }

    pub const fn parallel_execution_allowed(&self) -> bool {
        self.parallel_execution_allowed
    }

    pub const fn with_parallel_execution(mut self) -> Self {
        self.parallel_execution_allowed = true;
        self
    }

    pub fn allow(&mut self) -> Result<(), ToolTransitionError> {
        self.ensure_authorization_pending()?;
        self.authorize(ToolAuthorization::Allowed, ToolState::Authorized)
    }

    pub fn require_approval(&mut self) -> Result<(), ToolTransitionError> {
        self.ensure_requested(ToolState::Requested)?;
        self.ensure_authorization_pending()?;
        self.authorization = ToolAuthorization::ApprovalRequired;
        Ok(())
    }

    pub fn approve(&mut self) -> Result<(), ToolTransitionError> {
        self.ensure_requested(ToolState::Authorized)?;
        if self.authorization != ToolAuthorization::ApprovalRequired {
            return Err(ToolTransitionError::ApprovalNotRequired {
                authorization: self.authorization,
            });
        }
        self.authorization = ToolAuthorization::Allowed;
        self.state = ToolState::Authorized;
        Ok(())
    }

    pub fn deny(&mut self) -> Result<(), ToolTransitionError> {
        self.ensure_requested(ToolState::Denied)?;
        self.authorization = ToolAuthorization::Denied;
        self.state = ToolState::Denied;
        Ok(())
    }

    pub fn start(&mut self) -> Result<(), ToolTransitionError> {
        if self.state.is_terminal() {
            return Err(ToolTransitionError::TerminalState {
                source: self.state,
                target: ToolState::Running,
            });
        }
        if self.state != ToolState::Authorized || self.authorization != ToolAuthorization::Allowed {
            return Err(ToolTransitionError::NotAuthorized {
                state: self.state,
                authorization: self.authorization,
            });
        }
        self.state = ToolState::Running;
        Ok(())
    }

    pub fn complete(&mut self) -> Result<(), ToolTransitionError> {
        self.finish(ToolState::Completed)
    }

    pub fn fail(&mut self) -> Result<(), ToolTransitionError> {
        self.finish(ToolState::Failed)
    }

    pub fn time_out(&mut self) -> Result<(), ToolTransitionError> {
        self.finish(ToolState::TimedOut)
    }

    pub fn cancel(&mut self) -> Result<(), ToolTransitionError> {
        if self.state.is_terminal() {
            return Err(ToolTransitionError::TerminalState {
                source: self.state,
                target: ToolState::Cancelled,
            });
        }
        self.state = ToolState::Cancelled;
        Ok(())
    }

    pub fn ensure_auto_retry_allowed(
        &self,
        outcome: ToolOutcomeKnowledge,
    ) -> Result<(), ToolRetryError> {
        if !matches!(self.state, ToolState::Failed | ToolState::TimedOut) {
            return Err(ToolRetryError::StateNotRetryable { state: self.state });
        }
        if self.side_effect == ToolSideEffect::ExternalEffect
            && outcome == ToolOutcomeKnowledge::Unknown
        {
            return Err(ToolRetryError::ExternalEffectOutcomeUnknown);
        }
        Ok(())
    }

    fn authorize(
        &mut self,
        authorization: ToolAuthorization,
        target: ToolState,
    ) -> Result<(), ToolTransitionError> {
        self.ensure_requested(target)?;
        self.authorization = authorization;
        self.state = target;
        Ok(())
    }

    fn ensure_requested(&self, target: ToolState) -> Result<(), ToolTransitionError> {
        if self.state.is_terminal() {
            return Err(ToolTransitionError::TerminalState {
                source: self.state,
                target,
            });
        }
        if self.state != ToolState::Requested {
            return Err(ToolTransitionError::IllegalTransition {
                source: self.state,
                target,
            });
        }
        Ok(())
    }

    fn ensure_authorization_pending(&self) -> Result<(), ToolTransitionError> {
        if self.authorization != ToolAuthorization::Pending {
            return Err(ToolTransitionError::AuthorizationAlreadyDecided {
                authorization: self.authorization,
            });
        }
        Ok(())
    }

    fn finish(&mut self, target: ToolState) -> Result<(), ToolTransitionError> {
        if self.state.is_terminal() {
            return Err(ToolTransitionError::TerminalState {
                source: self.state,
                target,
            });
        }
        if self.state != ToolState::Running {
            return Err(ToolTransitionError::IllegalTransition {
                source: self.state,
                target,
            });
        }
        self.state = target;
        Ok(())
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ToolTransitionError {
    IllegalTransition {
        source: ToolState,
        target: ToolState,
    },
    TerminalState {
        source: ToolState,
        target: ToolState,
    },
    NotAuthorized {
        state: ToolState,
        authorization: ToolAuthorization,
    },
    ApprovalNotRequired {
        authorization: ToolAuthorization,
    },
    AuthorizationAlreadyDecided {
        authorization: ToolAuthorization,
    },
}

impl Display for ToolTransitionError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        write!(formatter, "tool transition rejected: {self:?}")
    }
}

impl Error for ToolTransitionError {}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ToolRetryError {
    StateNotRetryable { state: ToolState },
    ExternalEffectOutcomeUnknown,
}

impl Display for ToolRetryError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        write!(formatter, "tool auto-retry rejected: {self:?}")
    }
}

impl Error for ToolRetryError {}

#[cfg(test)]
mod tests {
    use super::*;

    type Step = fn(&mut ToolCallStateMachine) -> Result<(), ToolTransitionError>;

    #[test]
    fn accepts_the_declared_transition_table() {
        let cases: &[(&[Step], ToolState, ToolAuthorization)] = &[
            (
                &[ToolCallStateMachine::allow],
                ToolState::Authorized,
                ToolAuthorization::Allowed,
            ),
            (
                &[ToolCallStateMachine::allow, ToolCallStateMachine::start],
                ToolState::Running,
                ToolAuthorization::Allowed,
            ),
            (
                &[
                    ToolCallStateMachine::allow,
                    ToolCallStateMachine::start,
                    ToolCallStateMachine::complete,
                ],
                ToolState::Completed,
                ToolAuthorization::Allowed,
            ),
            (
                &[
                    ToolCallStateMachine::require_approval,
                    ToolCallStateMachine::approve,
                    ToolCallStateMachine::start,
                ],
                ToolState::Running,
                ToolAuthorization::Allowed,
            ),
            (
                &[ToolCallStateMachine::deny],
                ToolState::Denied,
                ToolAuthorization::Denied,
            ),
            (
                &[ToolCallStateMachine::cancel],
                ToolState::Cancelled,
                ToolAuthorization::Pending,
            ),
        ];

        for (steps, expected_state, expected_authorization) in cases {
            let mut machine = ToolCallStateMachine::new(ToolSideEffect::None);
            for step in *steps {
                step(&mut machine).expect("declared transition must be accepted");
            }
            assert_eq!(machine.state(), *expected_state);
            assert_eq!(machine.authorization(), *expected_authorization);
        }
    }

    #[test]
    fn rejects_running_without_explicit_authorization() {
        let cases = [
            (
                ToolCallStateMachine::new(ToolSideEffect::None),
                ToolAuthorization::Pending,
            ),
            (
                {
                    let mut machine = ToolCallStateMachine::new(ToolSideEffect::None);
                    machine.require_approval().unwrap();
                    machine
                },
                ToolAuthorization::ApprovalRequired,
            ),
        ];

        for (mut machine, authorization) in cases {
            assert_eq!(
                machine.start(),
                Err(ToolTransitionError::NotAuthorized {
                    state: ToolState::Requested,
                    authorization,
                })
            );
            assert_eq!(machine.state(), ToolState::Requested);
        }
    }

    #[test]
    fn every_terminal_state_rejects_another_terminal_result() {
        let terminal_steps: &[(Step, ToolState)] = &[
            (ToolCallStateMachine::complete, ToolState::Completed),
            (ToolCallStateMachine::fail, ToolState::Failed),
            (ToolCallStateMachine::time_out, ToolState::TimedOut),
        ];
        for (terminal, expected) in terminal_steps {
            let mut machine = running_machine(ToolSideEffect::None);
            terminal(&mut machine).unwrap();
            assert_eq!(machine.state(), *expected);
            assert_eq!(
                machine.fail(),
                Err(ToolTransitionError::TerminalState {
                    source: *expected,
                    target: ToolState::Failed,
                })
            );
        }

        for mut machine in [denied_machine(), {
            let mut machine = ToolCallStateMachine::new(ToolSideEffect::None);
            machine.cancel().unwrap();
            machine
        }] {
            let terminal = machine.state();
            assert_eq!(
                machine.complete(),
                Err(ToolTransitionError::TerminalState {
                    source: terminal,
                    target: ToolState::Completed,
                })
            );
        }
    }

    #[test]
    fn unknown_external_effect_outcome_cannot_auto_retry() {
        let retry_cases = [
            (
                failed_machine(ToolSideEffect::ExternalEffect),
                ToolOutcomeKnowledge::Unknown,
                Err(ToolRetryError::ExternalEffectOutcomeUnknown),
            ),
            (
                failed_machine(ToolSideEffect::ExternalEffect),
                ToolOutcomeKnowledge::Known,
                Ok(()),
            ),
            (
                failed_machine(ToolSideEffect::None),
                ToolOutcomeKnowledge::Unknown,
                Ok(()),
            ),
            (
                running_machine(ToolSideEffect::None),
                ToolOutcomeKnowledge::Known,
                Err(ToolRetryError::StateNotRetryable {
                    state: ToolState::Running,
                }),
            ),
        ];

        for (machine, knowledge, expected) in retry_cases {
            assert_eq!(machine.ensure_auto_retry_allowed(knowledge), expected);
        }
    }

    #[test]
    fn parallel_execution_is_opt_in_and_disabled_by_default() {
        let default_machine = ToolCallStateMachine::new(ToolSideEffect::StagedWrite);
        let parallel_machine = default_machine.with_parallel_execution();

        assert!(!default_machine.parallel_execution_allowed());
        assert!(parallel_machine.parallel_execution_allowed());
    }

    fn running_machine(side_effect: ToolSideEffect) -> ToolCallStateMachine {
        let mut machine = ToolCallStateMachine::new(side_effect);
        machine.allow().unwrap();
        machine.start().unwrap();
        machine
    }

    fn failed_machine(side_effect: ToolSideEffect) -> ToolCallStateMachine {
        let mut machine = running_machine(side_effect);
        machine.fail().unwrap();
        machine
    }

    fn denied_machine() -> ToolCallStateMachine {
        let mut machine = ToolCallStateMachine::new(ToolSideEffect::None);
        machine.deny().unwrap();
        machine
    }
}
