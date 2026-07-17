import failedImageUrl from "../../assets/image-generation-failed.jpg";

export function FailedImagePlaceholder(props: {
  className?: string;
  compact?: boolean;
  label?: string;
}) {
  const label = props.label ?? "图片生成失败";
  return (
    <div
      className={`image-failure-placeholder${props.compact ? " image-failure-placeholder--compact" : ""}${props.className ? ` ${props.className}` : ""}`}
      data-image-present="false"
      role="img"
      aria-label={`${label}；没有图片内容`}
    >
      <img src={failedImageUrl} alt="" aria-hidden="true" />
      <span><strong>{label}</strong><small>没有图片内容</small></span>
    </div>
  );
}
