import { AlertTriangle, Image, LoaderCircle } from "lucide-react";
import type { CreativeShowcaseSnapshot } from "../../../../shared/ipcContract";
import { FailedImagePlaceholder } from "./FailedImagePlaceholder";

type ShowcaseImage = CreativeShowcaseSnapshot["images"][number];

export function ImageAssetCard(props: {
  image: ShowcaseImage;
  featured?: boolean;
  onSelect?(): void;
  onOpenResource(resourceId: string): Promise<void> | void;
}) {
  const renderable = (props.image.status === "ready" || props.image.status === "stale")
    && props.image.thumbnailUrl !== null;
  return (
    <article
      className={`showcase-image-card${props.featured ? " showcase-image-card--featured" : ""}`}
      data-status={props.image.status}
      aria-label={`${props.image.title} · ${statusLabel(props.image.status)}`}
    >
      {renderable ? (
        <button className="showcase-image-card__visual" type="button" onClick={props.onSelect}>
          <img src={props.image.thumbnailUrl!} alt={props.image.title} loading={props.featured ? "eager" : "lazy"} />
        </button>
      ) : props.image.status === "failed" ? (
        <FailedImagePlaceholder label={`${props.image.title}生成失败`} />
      ) : (
        <div className="showcase-image-card__state" role="status">
          {props.image.status === "queued" || props.image.status === "generating"
            ? <LoaderCircle size={22} aria-hidden="true" />
            : props.image.status === "reconciliation_required"
              ? <AlertTriangle size={22} aria-hidden="true" />
              : <Image size={22} aria-hidden="true" />}
          <strong>{statusLabel(props.image.status)}</strong>
          <span>{props.image.statusMessage}</span>
        </div>
      )}
      <div className="showcase-image-card__caption">
        <span>{props.image.purpose === "character_portrait" ? "角色立绘" : "场景图"}</span>
        <strong>{props.image.title}</strong>
        <small>{statusLabel(props.image.status)}</small>
        {props.image.sourceResources.length ? (
          <div className="showcase-image-card__sources" aria-label="图片来源">
            {props.image.sourceResources.map((source) => (
              <button type="button" key={source.id} onClick={() => void props.onOpenResource(source.id)}>
                来源 · {source.title}
              </button>
            ))}
          </div>
        ) : null}
      </div>
    </article>
  );
}

function statusLabel(status: ShowcaseImage["status"]): string {
  switch (status) {
    case "queued": return "等待生成";
    case "generating": return "正在生成";
    case "ready": return "可用";
    case "stale": return "来源已变化";
    case "failed": return "生成失败";
    case "reconciliation_required": return "需要核对";
  }
}
