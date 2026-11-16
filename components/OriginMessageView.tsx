"use client";

import { useEffect, useRef, useState } from "react";
import { Bot, CornerUpLeft, GitFork, GitPullRequest, MessagesSquare } from "lucide-react";
import type { ImageContent, UserMessage } from "@/lib/types";
import { splitOriginHeader, type GithubMessageOrigin } from "@/lib/message-origin";
import { MessageCopyActions } from "./MessageCopyActions";
import { MarkdownBody } from "./MarkdownBody";
import { useI18n } from "@/lib/i18n";
import { ConfirmDialog } from "./ui/field";
import { Tooltip } from "./ui/primitives";
import { SessionLink } from "./SessionLink";
import { ClickableImage } from "./ImageLightbox";

function messageText(message: UserMessage): string {
  if (typeof message.content === "string") return message.content;
  return message.content.filter((block) => block.type === "text").map((block) => block.text).join("\n");
}

function messageImages(message: UserMessage): ImageContent[] {
  return typeof message.content === "string"
    ? []
    : message.content.filter((block): block is ImageContent => block.type === "image");
}

function imageSource(image: ImageContent): string {
  const flat = image as unknown as { data?: string; mimeType?: string };
  return image.source
    ? image.source.type === "base64"
      ? `data:${image.source.media_type};base64,${image.source.data}`
      : image.source.url ?? ""
    : flat.data
      ? `data:${flat.mimeType};base64,${flat.data}`
      : "";
}

function githubEvent(event: GithubMessageOrigin["github"]["events"][number]): string {
  const who = event.author ? ` from ${event.author}` : "";
  const state = event.state ? ` · ${event.state.toLowerCase().replaceAll("_", " ")}` : "";
  if (event.kind === "review") return `Review${who}${state}`;
  if (event.kind === "comment") return `Comment${who}`;
  if (event.kind === "thread_comment") return `Inline comment${who}`;
  if (event.kind === "ci") return "CI completed";
  if (event.kind === "workflow_run") return `Workflow run${state}`;
  return event.kind === "merged" ? "Merged" : event.kind === "closed" ? `Closed${state}` : event.kind;
}

export function OriginMessageView({
  message,
  cwd,
  onOpenFile,
  sessionId,
  entryId,
  onFork,
  forking,
  forkDisabled,
  onEdit,
  editing,
  editDisabled,
}: {
  message: UserMessage;
  cwd?: string;
  onOpenFile?: (filePath: string) => void;
  sessionId?: string;
  entryId?: string;
  onFork?: (entryId: string, editPrompt: boolean) => void;
  forking?: boolean;
  forkDisabled?: boolean;
  onEdit?: (entryId: string, content: string) => Promise<boolean>;
  editing?: boolean;
  editDisabled?: boolean;
}) {
  const { t } = useI18n();
  const origin = message.origin!;
  const raw = messageText(message);
  const images = messageImages(message);
  const split = origin.kind === "session" ? splitOriginHeader(raw) : null;
  const body = split?.body ?? raw;
  const [showRaw, setShowRaw] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);
  const session = origin.kind === "session" ? origin.session : undefined;
  const [confirmingEditId, setConfirmingEditId] = useState<string | null>(null);
  const [confirmingForkId, setConfirmingForkId] = useState<string | null>(null);
  useEffect(() => {
    setConfirmingEditId(null);
    setConfirmingForkId(null);
  }, [entryId]);
  const github = origin.kind === "github" ? origin.github : undefined;
  const title = session ? "Session message" : github ? "GitHub update" : "Automated message";
  const Icon = session ? MessagesSquare : github ? GitPullRequest : Bot;
  const label = session
    ? `Message from session ${session.name?.trim() || "Untitled session"} on ${session.hostLabel}`
    : github ? `Automated GitHub update for ${github.repo}#${github.number}` : "Automated message from omp-web";
  return (
    <article aria-label={label} style={{ marginBottom: 18, paddingRight: 6 }}>
      <div className="chat-message-card" style={{ width: "100%", minWidth: 0, border: "1px solid var(--border)", borderLeft: "3px solid var(--accent)", borderRadius: "var(--radius-card)", background: "var(--bg)", overflow: "hidden" }}>
        <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8, padding: "8px 12px", background: "var(--bg-panel)", borderBottom: "1px solid var(--border)", color: "var(--text-muted)", fontSize: 12 }}>
          <Icon size={14} aria-hidden="true" />
          <strong style={{ color: "var(--text)" }}>{title}</strong>
          {session && <><span>From <SessionLink session={session} /></span><span>{session.hostLabel} · {session.delivery === "followUp" ? "Follow-up" : session.delivery === "prompt" ? "New turn" : "Steer"}</span></>}
          {github && <a href={github.url} target="_blank" rel="noopener noreferrer" aria-label={`Open ${github.repo}#${github.number} on GitHub`} style={{ color: "var(--accent)", fontWeight: 600 }}>{github.repo}#{github.number}</a>}
          <time dateTime={origin.sentAt} title={new Date(origin.sentAt).toLocaleString()} style={{ marginLeft: "auto" }}>{new Date(origin.sentAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time>
        </div>
        <div ref={bodyRef} data-selection-scope="message" tabIndex={-1} style={{ maxHeight: 300, overflowY: "auto", padding: "8px 12px", color: "var(--text)", fontSize: "var(--chat-user-font-size)", lineHeight: "var(--chat-line-height)", overflowWrap: "anywhere" }}>
          {github?.events.length ? <ul style={{ margin: "0 0 8px", paddingLeft: 18 }}>{github.events.map((event, index) => <li key={`${event.kind}-${index}`}>{githubEvent(event)}</li>)}</ul> : null}
          {images.length > 0 && (
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: body ? 8 : 0 }}>
              {images.map((image, index) => {
                const src = imageSource(image);
                return src ? <ClickableImage key={index} src={src} alt="" style={{ maxWidth: 240, maxHeight: 240, borderRadius: 6, objectFit: "contain", display: "block", border: "1px solid var(--border)" }} /> : null;
              })}
            </div>
          )}
          <div data-message-text><MarkdownBody className="markdown-user-message" cwd={cwd} onOpenFile={onOpenFile} sourceSessionId={sessionId}>{showRaw ? raw : body}</MarkdownBody></div>
        </div>
        <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", justifyContent: "flex-end", gap: 6, padding: "3px 10px 7px" }}>
          {entryId && onEdit && (
            <>
              <ConfirmDialog
                open={confirmingEditId === entryId}
                onOpenChange={(open) => setConfirmingEditId(open ? entryId ?? null : null)}
                title={t("messageView.editConfirmTitle")}
                description={t("messageView.editConfirmBody")}
                confirmLabel={t("messageView.editFromHere")}
                cancelLabel={t("chatInput.cancel")}
                onConfirm={() => { const id = confirmingEditId; setConfirmingEditId(null); if (id === entryId && !editing && !editDisabled) void onEdit(id, body); }}
              />
              <Tooltip content={t("messageView.editFromHereTitle")}>
                <button type="button" disabled={editing || editDisabled} onClick={() => setConfirmingEditId(entryId ?? null)} aria-label={t("messageView.editFromHereTitle")} style={{ display: "flex", alignItems: "center", gap: 4, padding: "3px 8px", border: 0, background: "none", color: "var(--text-dim)", fontSize: 11, cursor: "pointer" }}>
                  <CornerUpLeft size={11} aria-hidden="true" />{t("messageView.editFromHere")}
                </button>
              </Tooltip>
            </>
          )}
          {entryId && onFork && (
            <>
              <ConfirmDialog
                open={confirmingForkId === entryId}
                onOpenChange={(open) => setConfirmingForkId(open ? entryId ?? null : null)}
                title={t("messageView.forkConfirmTitle")}
                description={t("messageView.forkConfirmEditBody")}
                confirmLabel={t("messageView.newSession")}
                cancelLabel={t("chatInput.cancel")}
                onConfirm={() => { const id = confirmingForkId; setConfirmingForkId(null); if (id === entryId && !forking && !forkDisabled) onFork(id, true); }}
              />
              <Tooltip content={t("messageView.newSessionTitle")}>
                <button type="button" disabled={forking || forkDisabled} onClick={() => setConfirmingForkId(entryId ?? null)} aria-label={t("messageView.newSessionTitle")} style={{ display: "flex", alignItems: "center", gap: 4, padding: "3px 8px", border: 0, background: "none", color: "var(--text-dim)", fontSize: 11, cursor: "pointer" }}>
                  <GitFork size={11} aria-hidden="true" />{t("messageView.newSession")}
                </button>
              </Tooltip>
            </>
          )}
          {split && <button type="button" onClick={() => setShowRaw((shown) => !shown)} aria-expanded={showRaw} style={{ border: 0, background: "none", color: "var(--text-dim)", fontSize: 11, cursor: "pointer" }}>{showRaw ? "Hide raw message" : "Show raw message"}</button>}
          <MessageCopyActions texts={[raw]} bodyRef={bodyRef} />
        </div>
      </div>
    </article>
  );
}
