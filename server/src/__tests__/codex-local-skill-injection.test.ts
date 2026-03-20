import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ensureCodexSkillsInjected } from "@zeroinc/adapter-codex-local/server";

async function makeTempDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

async function createZeroIncRepoSkill(root: string, skillName: string) {
  await fs.mkdir(path.join(root, "server"), { recursive: true });
  await fs.mkdir(path.join(root, "packages", "adapter-utils"), { recursive: true });
  await fs.mkdir(path.join(root, "skills", skillName), { recursive: true });
  await fs.writeFile(path.join(root, "pnpm-workspace.yaml"), "packages:\n  - packages/*\n", "utf8");
  await fs.writeFile(path.join(root, "package.json"), '{"name":"zeroinc"}\n', "utf8");
  await fs.writeFile(
    path.join(root, "skills", skillName, "SKILL.md"),
    `---\nname: ${skillName}\n---\n`,
    "utf8",
  );
}

async function createCustomSkill(root: string, skillName: string) {
  await fs.mkdir(path.join(root, "custom", skillName), { recursive: true });
  await fs.writeFile(
    path.join(root, "custom", skillName, "SKILL.md"),
    `---\nname: ${skillName}\n---\n`,
    "utf8",
  );
}

describe("codex local adapter skill injection", () => {
  const cleanupDirs = new Set<string>();

  afterEach(async () => {
    await Promise.all(Array.from(cleanupDirs).map((dir) => fs.rm(dir, { recursive: true, force: true })));
    cleanupDirs.clear();
  });

  it("repairs a Codex ZeroInc skill symlink that still points at another live checkout", async () => {
    const currentRepo = await makeTempDir("zeroinc-codex-current-");
    const oldRepo = await makeTempDir("zeroinc-codex-old-");
    const skillsHome = await makeTempDir("zeroinc-codex-home-");
    cleanupDirs.add(currentRepo);
    cleanupDirs.add(oldRepo);
    cleanupDirs.add(skillsHome);

    await createZeroIncRepoSkill(currentRepo, "zeroinc");
    await createZeroIncRepoSkill(oldRepo, "zeroinc");
    await fs.symlink(path.join(oldRepo, "skills", "zeroinc"), path.join(skillsHome, "zeroinc"));

    const logs: Array<{ stream: "stdout" | "stderr"; chunk: string }> = [];
    await ensureCodexSkillsInjected(
      async (stream, chunk) => {
        logs.push({ stream, chunk });
      },
      {
        skillsHome,
        skillsEntries: [{ name: "zeroinc", source: path.join(currentRepo, "skills", "zeroinc") }],
      },
    );

    expect(await fs.realpath(path.join(skillsHome, "zeroinc"))).toBe(
      await fs.realpath(path.join(currentRepo, "skills", "zeroinc")),
    );
    expect(logs).toContainEqual(
      expect.objectContaining({
        stream: "stdout",
        chunk: expect.stringContaining('Repaired Codex skill "zeroinc"'),
      }),
    );
  });

  it("preserves a custom Codex skill symlink outside ZeroInc repo checkouts", async () => {
    const currentRepo = await makeTempDir("zeroinc-codex-current-");
    const customRoot = await makeTempDir("zeroinc-codex-custom-");
    const skillsHome = await makeTempDir("zeroinc-codex-home-");
    cleanupDirs.add(currentRepo);
    cleanupDirs.add(customRoot);
    cleanupDirs.add(skillsHome);

    await createZeroIncRepoSkill(currentRepo, "zeroinc");
    await createCustomSkill(customRoot, "zeroinc");
    await fs.symlink(path.join(customRoot, "custom", "zeroinc"), path.join(skillsHome, "zeroinc"));

    await ensureCodexSkillsInjected(async () => {}, {
      skillsHome,
      skillsEntries: [{ name: "zeroinc", source: path.join(currentRepo, "skills", "zeroinc") }],
    });

    expect(await fs.realpath(path.join(skillsHome, "zeroinc"))).toBe(
      await fs.realpath(path.join(customRoot, "custom", "zeroinc")),
    );
  });
});
