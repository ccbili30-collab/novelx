use novelx_runtime::context_compiler::{
    ContextCompileRequest, ContextCompiler, ContextCompilerError, ContextItem, ContextItemClass,
    ContextPolicy, OutputReservePolicy, ToolTranscriptEntry, estimate_text_tokens,
};

const ESTIMATOR_VERSION: &str = "novelx.unicode-mixed-v1@1.0.0";

#[test]
fn estimates_ascii_chinese_and_emoji_deterministically() {
    let ascii = estimate_text_tokens("a".repeat(400).as_str());
    let chinese = estimate_text_tokens("银湾海岸".repeat(100).as_str());
    let emoji = estimate_text_tokens("🌊🧭".repeat(100).as_str());

    assert_eq!(ascii, estimate_text_tokens("a".repeat(400).as_str()));
    assert_eq!(
        chinese,
        estimate_text_tokens("银湾海岸".repeat(100).as_str())
    );
    assert_eq!(emoji, estimate_text_tokens("🌊🧭".repeat(100).as_str()));
    assert!(chinese > ascii);
    assert!(emoji > 0);
}

#[test]
fn class_breakdown_sums_to_the_compiled_input_total() {
    let compiled = ContextCompiler::compile(ContextCompileRequest {
        policy: generous_policy(),
        items: vec![
            required("system", ContextItemClass::SystemPrompt, "系统约束"),
            required("tools", ContextItemClass::ToolProtocol, "工具协议"),
            required("history", ContextItemClass::SessionHistory, "历史消息"),
            required("retrieval", ContextItemClass::Retrieval, "稳定世界资料"),
            required("current", ContextItemClass::CurrentUserTurn, "继续创作"),
        ],
        tool_transcript: vec![],
    })
    .unwrap();

    assert_eq!(compiled.estimator_version, ESTIMATOR_VERSION);
    assert_eq!(
        compiled.breakdown.estimated_input_tokens,
        compiled.breakdown.sum_classes()
    );
    assert_eq!(
        compiled.breakdown.available_input_budget,
        compiled.context_window
            - compiled.breakdown.safety_reserve
            - compiled.breakdown.output_reserve
    );
}

#[test]
fn auto_reserve_uses_the_remaining_window_with_declared_bounds() {
    let mut request = request_with_text("current", "当前输入");
    request.policy.context_window = 64_000;
    request.policy.safety_reserve = 6_400;
    request.policy.output_reserve = OutputReservePolicy::Auto {
        minimum: 1_024,
        maximum: 32_768,
        target: 12_400,
    };

    let compiled = ContextCompiler::compile(request).unwrap();

    assert_eq!(compiled.breakdown.output_reserve, 12_400);
    assert!(
        compiled.breakdown.estimated_input_tokens
            + compiled.breakdown.output_reserve
            + compiled.breakdown.safety_reserve
            <= compiled.context_window
    );
}

#[test]
fn exact_fit_is_accepted_and_one_token_less_is_rejected() {
    let text = "银湾海岸".repeat(200);
    let estimated = estimate_text_tokens(&text);
    let safety_reserve = 128;
    let output_reserve = 256;
    let exact_window = estimated + safety_reserve + output_reserve;
    let policy = ContextPolicy {
        context_window: exact_window,
        safety_reserve,
        output_reserve: OutputReservePolicy::Fixed(output_reserve),
        estimator_version: ESTIMATOR_VERSION.to_owned(),
    };

    let exact = ContextCompiler::compile(ContextCompileRequest {
        policy: policy.clone(),
        items: vec![required(
            "current",
            ContextItemClass::CurrentUserTurn,
            &text,
        )],
        tool_transcript: vec![],
    })
    .unwrap();
    assert_eq!(exact.breakdown.estimated_input_tokens, estimated);

    let error = ContextCompiler::compile(ContextCompileRequest {
        policy: ContextPolicy {
            context_window: exact_window - 1,
            ..policy
        },
        items: vec![required(
            "current",
            ContextItemClass::CurrentUserTurn,
            &text,
        )],
        tool_transcript: vec![],
    })
    .unwrap_err();
    assert!(matches!(
        error,
        ContextCompilerError::RequiredContextExceedsWindow { .. }
    ));
}

#[test]
fn an_oversized_required_item_fails_closed_instead_of_being_truncated() {
    let mut request = request_with_text("canonical-rule", &"世界规则".repeat(10_000));
    request.policy.context_window = 1_024;

    let error = ContextCompiler::compile(request).unwrap_err();

    assert!(matches!(
        error,
        ContextCompilerError::RequiredContextExceedsWindow { item_id, .. }
            if item_id == "canonical-rule"
    ));
}

#[test]
fn tool_calls_and_results_must_be_exactly_paired_by_id_and_name() {
    let paired = ContextCompiler::compile(ContextCompileRequest {
        policy: generous_policy(),
        items: vec![required(
            "current",
            ContextItemClass::CurrentUserTurn,
            "读取资料",
        )],
        tool_transcript: vec![
            ToolTranscriptEntry::Call {
                tool_call_id: "call-1".to_owned(),
                tool_name: "read_project_file".to_owned(),
                arguments_sha256: "a".repeat(64),
            },
            ToolTranscriptEntry::Result {
                tool_call_id: "call-1".to_owned(),
                tool_name: "read_project_file".to_owned(),
                result_sha256: "b".repeat(64),
                is_error: false,
            },
        ],
    })
    .unwrap();
    assert_eq!(paired.tool_pairs.len(), 1);

    for transcript in [
        vec![ToolTranscriptEntry::Result {
            tool_call_id: "orphan".to_owned(),
            tool_name: "read_project_file".to_owned(),
            result_sha256: "b".repeat(64),
            is_error: false,
        }],
        vec![
            ToolTranscriptEntry::Call {
                tool_call_id: "mismatch".to_owned(),
                tool_name: "read_project_file".to_owned(),
                arguments_sha256: "a".repeat(64),
            },
            ToolTranscriptEntry::Result {
                tool_call_id: "mismatch".to_owned(),
                tool_name: "save_task_note".to_owned(),
                result_sha256: "b".repeat(64),
                is_error: false,
            },
        ],
    ] {
        let error = ContextCompiler::compile(ContextCompileRequest {
            policy: generous_policy(),
            items: vec![required(
                "current",
                ContextItemClass::CurrentUserTurn,
                "继续",
            )],
            tool_transcript: transcript,
        })
        .unwrap_err();
        assert!(matches!(
            error,
            ContextCompilerError::ToolPairingInvalid { .. }
        ));
    }
}

#[test]
fn omitting_optional_material_marks_the_packet_incomplete() {
    let request = ContextCompileRequest {
        policy: ContextPolicy {
            context_window: 2_048,
            safety_reserve: 128,
            output_reserve: OutputReservePolicy::Fixed(256),
            estimator_version: ESTIMATOR_VERSION.to_owned(),
        },
        items: vec![
            required("current", ContextItemClass::CurrentUserTurn, "继续写作"),
            ContextItem::optional(
                "retrieval-large",
                ContextItemClass::Retrieval,
                "历史资料".repeat(10_000),
                100,
            ),
        ],
        tool_transcript: vec![],
    };

    let compiled = ContextCompiler::compile(request).unwrap();

    assert!(compiled.completeness.incomplete);
    assert_eq!(
        compiled.completeness.omitted_item_ids,
        vec!["retrieval-large"]
    );
    assert!(!compiled.packet.contains("历史资料"));
}

#[test]
fn identical_inputs_produce_the_same_canonical_packet_hash() {
    let request = request_with_text("current", "银湾海岸为何曲折？");

    let first = ContextCompiler::compile(request.clone()).unwrap();
    let second = ContextCompiler::compile(request).unwrap();

    assert_eq!(first.packet_sha256, second.packet_sha256);
    assert_eq!(first.packet, second.packet);
    assert_eq!(first.breakdown, second.breakdown);
}

fn request_with_text(id: &str, text: &str) -> ContextCompileRequest {
    ContextCompileRequest {
        policy: generous_policy(),
        items: vec![required(id, ContextItemClass::CurrentUserTurn, text)],
        tool_transcript: vec![],
    }
}

fn required(id: &str, class: ContextItemClass, content: &str) -> ContextItem {
    ContextItem::required(id, class, content.to_owned())
}

fn generous_policy() -> ContextPolicy {
    ContextPolicy {
        context_window: 64_000,
        safety_reserve: 6_400,
        output_reserve: OutputReservePolicy::Fixed(8_000),
        estimator_version: ESTIMATOR_VERSION.to_owned(),
    }
}
