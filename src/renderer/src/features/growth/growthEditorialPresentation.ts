import type { GrowthPresentationSnapshot } from "../../../../shared/growthPresentationContract";

export type EditorialActivityEvent = GrowthPresentationSnapshot["activityEvents"][number];

export function growthActivityKindLabel(kind: EditorialActivityEvent["kind"]): string {
  return ({
    director_planning: "规划编辑轮",
    employee_assigned: "已分派工作",
    candidate_ready: "候选已返回",
    checking: "检查已记录",
    revision_requested: "要求返修",
    committed: "已提交",
    image_queued: "配图已排队",
    image_ready: "配图已就绪",
    image_failed: "配图生成失败",
  })[kind];
}

export function growthActivityActorLabel(actor: EditorialActivityEvent["actor"]): string {
  return ({
    world_director: "世界总编",
    world_system_author: "世界系统作者",
    geography_ecology_author: "地理生态作者",
    civilization_author: "文明作者",
    organization_author: "组织作者",
    species_culture_author: "物种文化作者",
    character_author: "角色作者",
    story_architect: "故事架构师",
    writer: "作家",
    general_setting_author: "通用设定作者",
    graph_curator: "图谱策展人",
    visual_director: "视觉总监",
    checker: "检查员",
    gm: "主持人",
    decomposer: "资料拆解员",
  })[actor];
}
