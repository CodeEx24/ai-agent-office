import type { SkillVersion } from "@ago/shared";

import { MarkdownPreview } from "./MarkdownPreview";

/**
 * Every version of a skill, newest first. Old versions stay readable and are never editable:
 * restoring one means copying its text into the editor and saving, which stores a new version.
 */
export function VersionHistory({
  versions,
  currentVersion,
}: {
  versions: SkillVersion[];
  currentVersion: number;
}) {
  return (
    <section className="grid min-w-0 gap-3" aria-label="Version history">
      <h2 className="text-lg font-semibold">Version history</h2>
      <ol className="grid min-w-0 gap-2" data-testid="version-history">
        {versions.map((version) => (
          <li
            key={version.id}
            className="min-w-0 rounded-md border"
            data-testid={`version-${String(version.version)}`}
          >
            <details>
              <summary className="cursor-pointer px-3 py-2 text-sm">
                <span className="font-medium">Version {version.version}</span>
                {version.version === currentVersion ? " (current)" : ""}
                <span className="text-muted-foreground">
                  {" "}
                  · {new Date(version.createdAt).toISOString().slice(0, 16).replace("T", " ")} UTC
                </span>
              </summary>
              <div className="min-w-0 border-t p-3">
                <MarkdownPreview text={version.body} />
              </div>
            </details>
          </li>
        ))}
      </ol>
    </section>
  );
}
