import { useEffect, useMemo, useState } from "react";
import { BookOpenText, CircleUserRound, Image, LoaderCircle, Network, Play, Sparkles } from "lucide-react";
import type { CreativeShowcaseSnapshot, WorkspaceSnapshot } from "../../../../shared/ipcContract";
import { AgentMessageContent } from "../agent/AgentMessageContent";
import { ImageAssetCard } from "../assets/ImageAssetCard";
import { SemanticGraphView } from "../graph/SemanticGraphView";

export function CreativeShowcase(props: {
  workspace: WorkspaceSnapshot;
  refreshKey: number;
  storyResourceId?: string | null;
  onStoryChange?(storyResourceId: string): void;
  onEnterPlayer(input: {
    storyResourceId: string;
    worldResourceId: string;
    storyTitle: string;
    ocResourceIds: string[];
  }): Promise<void>;
  onOpenResource(resourceId: string): Promise<void> | void;
  onOpenDocument(documentId: string, resourceId: string): Promise<void> | void;
}) {
  const stories = useMemo(
    () => props.workspace.resources.filter((resource) => resource.type === "story" && resource.objectKind === "story"),
    [props.workspace.resources],
  );
  const [storyId, setStoryId] = useState<string | null>(props.storyResourceId ?? stories[0]?.id ?? null);
  const [showcase, setShowcase] = useState<CreativeShowcaseSnapshot | null>(null);
  const [selectedDocumentId, setSelectedDocumentId] = useState<string | null>(null);
  const [selectedImageId, setSelectedImageId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedWorldId, setSelectedWorldId] = useState("");
  const [launchingPlayer, setLaunchingPlayer] = useState(false);
  const [launchError, setLaunchError] = useState<string | null>(null);

  const selectedStory = stories.find((story) => story.id === storyId) ?? null;
  const selectedDocument = showcase?.proseDocuments.find((document) => document.documentId === selectedDocumentId)
    ?? showcase?.proseDocuments[0] ?? null;
  const selectedImage = showcase?.images.find((image) => image.assetId === selectedImageId)
    ?? showcase?.images.find((image) => image.status === "ready" || image.status === "stale")
    ?? showcase?.images[0] ?? null;
  const linkedWorlds = useMemo(() => {
    if (!storyId) return [];
    const ids = new Set(props.workspace.relations
      .filter((relation) => relation.kind === "uses_world" && relation.sourceResourceId === storyId)
      .map((relation) => relation.targetResourceId));
    return props.workspace.resources.filter((resource) => ids.has(resource.id) && resource.objectKind === "world");
  }, [props.workspace.relations, props.workspace.resources, storyId]);
  const linkedOcs = useMemo(() => {
    if (!storyId) return [];
    const ids = new Set(props.workspace.relations
      .filter((relation) => relation.kind === "uses_oc" && relation.sourceResourceId === storyId)
      .map((relation) => relation.targetResourceId));
    return props.workspace.resources.filter((resource) => ids.has(resource.id) && resource.objectKind === "oc");
  }, [props.workspace.relations, props.workspace.resources, storyId]);

  useEffect(() => {
    if (props.storyResourceId && stories.some((story) => story.id === props.storyResourceId)
      && props.storyResourceId !== storyId) {
      setStoryId(props.storyResourceId);
      return;
    }
    if (storyId && stories.some((story) => story.id === storyId)) return;
    setStoryId(stories[0]?.id ?? null);
  }, [props.storyResourceId, stories, storyId]);

  useEffect(() => {
    setSelectedWorldId((current) => {
      if (linkedWorlds.length === 1) return linkedWorlds[0].id;
      return linkedWorlds.some((world) => world.id === current) ? current : "";
    });
    setLaunchError(null);
  }, [linkedWorlds, storyId]);

  useEffect(() => {
    let active = true;
    setShowcase(null);
    setLoading(Boolean(storyId));
    setError(null);
    if (!storyId) return () => { active = false; };
    void window.novaxDesktop.showcase.get({ storyResourceId: storyId }).then((result) => {
      if (!active) return;
      if (!result.ok) throw new Error(result.error.message);
      setShowcase(result.showcase);
      setSelectedDocumentId((current) => result.showcase.proseDocuments.some((document) => document.documentId === current)
        ? current
        : result.showcase.proseDocuments[0]?.documentId ?? null);
      setSelectedImageId((current) => result.showcase.images.some((image) => image.assetId === current)
        ? current
        : result.showcase.images.find((image) => image.status === "ready" || image.status === "stale")?.assetId ?? null);
    }).catch((cause: unknown) => {
      if (active) setError(readErrorMessage(cause));
    }).finally(() => {
      if (active) setLoading(false);
    });
    return () => { active = false; };
  }, [props.refreshKey, props.workspace.workspaceId, storyId]);

  function changeStory(nextStoryId: string) {
    setStoryId(nextStoryId);
    props.onStoryChange?.(nextStoryId);
  }

  async function enterPlayerMode() {
    if (!selectedStory || !selectedWorldId || launchingPlayer) return;
    setLaunchingPlayer(true);
    setLaunchError(null);
    try {
      await props.onEnterPlayer({
        storyResourceId: selectedStory.id,
        worldResourceId: selectedWorldId,
        storyTitle: selectedStory.title,
        ocResourceIds: linkedOcs.map((oc) => oc.id),
      });
    } catch (cause) {
      setLaunchError(readErrorMessage(cause));
    } finally {
      setLaunchingPlayer(false);
    }
  }

  return (
    <article className="creative-showcase" aria-label="创作联合展台">
      <header className="showcase-toolbar">
        <div>
          <span className="showcase-kicker"><Sparkles size={13} aria-hidden="true" />世界正在成形</span>
          <h1>创作联合展台</h1>
        </div>
        <div className="showcase-toolbar__controls">
          {stories.length > 1 ? (
            <label>故事
              <select value={selectedStory?.id ?? ""} onChange={(event) => changeStory(event.target.value)}>
                {stories.map((story) => <option value={story.id} key={story.id}>{story.title}</option>)}
              </select>
            </label>
          ) : selectedStory ? <span>{selectedStory.title}</span> : null}
          {linkedWorlds.length > 1 ? (
            <label>游玩世界
              <select aria-label="游玩世界" value={selectedWorldId} onChange={(event) => setSelectedWorldId(event.target.value)}>
                <option value="">请选择</option>
                {linkedWorlds.map((world) => <option value={world.id} key={world.id}>{world.title}</option>)}
              </select>
            </label>
          ) : null}
          <button
            className="showcase-enter-player"
            type="button"
            onClick={() => void enterPlayerMode()}
            disabled={!selectedStory || !selectedWorldId || launchingPlayer}
          >
            {launchingPlayer ? <LoaderCircle className="spin" size={14} aria-hidden="true" /> : <Play size={14} aria-hidden="true" />}
            {launchingPlayer ? "正在进入" : "进入玩家模式"}
          </button>
          <span>{showcase?.images.length ?? 0} 张图 · {showcase?.characters.length ?? 0} 个角色 · {showcase?.graph.nodes.length ?? 0} 个图谱节点</span>
        </div>
      </header>

      <div className="showcase-notices">
        {error ? <div className="showcase-error" role="alert">{error}</div> : null}
        {!selectedStory ? <div className="showcase-launch-note">当前项目没有可游玩的故事。</div>
          : linkedWorlds.length === 0 ? <div className="showcase-launch-note" role="status">这个故事尚未绑定世界，补充世界关系后才能进入玩家模式。</div>
            : <div className="showcase-launch-note" role="status">
                <span>游玩世界：{linkedWorlds.find((world) => world.id === selectedWorldId)?.title ?? "等待选择"}</span>
                <span>绑定 OC：{linkedOcs.length ? linkedOcs.map((oc) => oc.title).join("、") : "无"}</span>
              </div>}
        {launchError ? <div className="showcase-error" role="alert">进入玩家模式失败：{launchError}</div> : null}
      </div>
      <div className="showcase-scroll">
        <div className="showcase-lead">
          <section className="showcase-visual" aria-label="视觉资产">
            {selectedImage ? (
              <ImageAssetCard image={selectedImage} featured onOpenResource={props.onOpenResource} />
            ) : (
              <div className="showcase-visual__empty">
                {loading ? <LoaderCircle size={24} aria-hidden="true" /> : <Image size={26} aria-hidden="true" />}
                <strong>{loading ? "正在读取视觉资产" : "这个故事还没有来源绑定的图片"}</strong>
                <span>{loading ? "" : "图片生成后会按真实资源与稳定版本显示在这里。"}</span>
              </div>
            )}
          </section>

          <section className="showcase-story" aria-label="故事正文">
            <header>
              <div><BookOpenText size={15} aria-hidden="true" /><span>正文</span></div>
              {(showcase?.proseDocuments.length ?? 0) > 1 ? (
                <select value={selectedDocument?.documentId ?? ""} onChange={(event) => setSelectedDocumentId(event.target.value)} aria-label="选择正文">
                  {showcase?.proseDocuments.map((item) => <option value={item.documentId} key={item.documentId}>{item.title}</option>)}
                </select>
              ) : null}
            </header>
            {selectedDocument ? (
              <>
                <button className="showcase-story__title" type="button" onClick={() => void props.onOpenDocument(selectedDocument.documentId, selectedDocument.resourceId)}>
                  <strong>{selectedDocument.title}</strong><span>打开稳定正文</span>
                </button>
                <div className="showcase-story__prose"><AgentMessageContent text={selectedDocument.content} /></div>
              </>
            ) : (
              <div className="showcase-section-empty">{selectedStory ? "这个故事还没有稳定正文。" : "当前项目没有可预览的故事。"}</div>
            )}
          </section>
        </div>

        {(showcase?.images.length ?? 0) > 1 ? (
          <div className="showcase-filmstrip" aria-label="图片资产列表">
            {showcase?.images.map((image) => (
              <button type="button" key={image.jobId} data-selected={image.jobId === selectedImage?.jobId} onClick={() => setSelectedImageId(image.assetId)}>
                {image.thumbnailUrl ? <img src={image.thumbnailUrl} alt="" loading="lazy" /> : <Image size={18} aria-hidden="true" />}
                <span>{image.title} · {image.statusMessage}</span>
              </button>
            ))}
          </div>
        ) : null}

        <div className="showcase-supporting">
          <section className="showcase-characters" aria-label="角色阵容">
            <header><CircleUserRound size={15} aria-hidden="true" /><span>角色阵容</span><small>{showcase?.characters.length ?? 0}</small></header>
            <div>
              {showcase?.characters.length ? showcase.characters.slice(0, 8).map((character) => {
                const portrait = showcase.images.find((image) => image.purpose === "character_portrait"
                  && image.sourceResourceIds.includes(character.id)
                  && image.thumbnailUrl);
                const profile = character.documents.find((document) => document.kind === "character_profile");
                return (
                  <article className="showcase-character-card" key={character.id}>
                    <button type="button" aria-label={`${character.title} · OC`} onClick={() => void props.onOpenResource(character.id)}>
                      {portrait?.thumbnailUrl ? <img src={portrait.thumbnailUrl} alt="" loading="lazy" /> : <span className="showcase-character-placeholder">{character.title.slice(0, 1)}</span>}
                      <strong>{character.title}</strong><small>OC</small>
                    </button>
                    <p>{profile ? firstParagraph(profile.content) : "尚无稳定角色资料。"}</p>
                  </article>
                );
              }) : <div className="showcase-section-empty">还没有角色。</div>}
            </div>
          </section>

          <details className="showcase-graph-card" aria-label="事件图谱预览" open>
            <summary><Network size={15} aria-hidden="true" /><span>事件与设定图谱</span><small>{showcase?.graph.nodes.length ?? 0} 个节点</small></summary>
            {showcase?.graph.nodes.length
              ? <SemanticGraphView
                  refreshKey={props.refreshKey}
                  snapshot={showcase.graph}
                  scopeResourceIds={showcase.graphScopeResourceIds}
                  embedded
                />
              : <div className="showcase-section-empty">当前故事范围内还没有已确认的图谱事实。</div>}
          </details>
        </div>
      </div>
    </article>
  );
}

function firstParagraph(content: string): string {
  const paragraph = content.split(/\n\s*\n/).map((part) => part.replace(/^#+\s*/gm, "").trim()).find(Boolean) ?? "";
  return paragraph.length <= 120 ? paragraph : `${paragraph.slice(0, 119)}…`;
}

function readErrorMessage(error: unknown): string {
  return error instanceof Error && error.message.trim() ? error.message : "联合展台暂时无法载入，请重试。";
}
