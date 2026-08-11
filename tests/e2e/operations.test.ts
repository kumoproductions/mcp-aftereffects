// End-to-end coverage for operation categories that have no offline tests at
// all — item, font, viewer, comp guides, Essential Graphics, and file-backed
// footage. Offline suites can only assert on generated JSX text; whether AE
// actually accepts these API calls, and what shape it answers with, is only
// knowable here.
//
// SESSION-MUTATING: closes the project currently open in After Effects, swaps
// in a disposable fixture, and restores the original afterwards (dirty or
// unsaved projects are Save-As'd first — see harness.backupAndOpenTestProject).
// Requires AE_MCP_E2E=1 on top of AE being reachable.

import { promises as fs } from "node:fs";
import * as path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { encodePngSrgb8 } from "../../src/color/png16.js";
import type { FileIpcTransport } from "../../src/transport/FileIpcTransport.js";
import type { SavedProjectState } from "./harness.js";
import {
  E2E_SCRATCH_DIR,
  backupAndOpenTestProject,
  buildFixtureProject,
  openCompInViewer,
  opRunner,
  printSkipBanner,
  probeAe,
  restoreUserProject,
} from "./harness.js";

const E2E_ENABLED = process.env.AE_MCP_E2E === "1";

let ready = false;
let transport: FileIpcTransport | null = null;
let saved: SavedProjectState | null = null;
let ops: ReturnType<typeof opRunner> | null = null;
let viewerReady = false;

/** Non-null accessor so each test body stays free of `!` noise. */
function o(): ReturnType<typeof opRunner> {
  if (!ops) throw new Error("suite not ready");
  return ops;
}

describe("e2e operations", () => {
  beforeAll(async () => {
    if (!E2E_ENABLED) {
      printSkipBanner("operations", "SKIPPING — AE_MCP_E2E not set", [
        " This suite closes the project currently open in After Effects and",
        " restores it afterwards (session-mutating). Opt in explicitly:",
        "   PowerShell : $env:AE_MCP_E2E = '1'; npm test",
        "   cmd        : set AE_MCP_E2E=1 && npm test",
      ]);
      return;
    }
    const probe = await probeAe("operations");
    if (!probe.ready || !probe.transport) return;
    transport = probe.transport;
    saved = await backupAndOpenTestProject(transport);
    await buildFixtureProject(transport);
    ops = opRunner(transport);
    viewerReady = await openCompInViewer(transport, "test_comp");
    ready = true;
  }, 180_000);

  afterAll(async () => {
    if (transport && saved) {
      await restoreUserProject(transport, saved);
    }
  });

  describe("project items", () => {
    it("creates a folder, lists it, renames it, and moves a comp into it", async (ctx) => {
      if (!ready) return ctx.skip();

      const folder = await o().run<{ id: number; name: string }>("folder.create", {
        name: "e2e_folder",
      });
      expect(folder.name).toBe("e2e_folder");
      expect(folder.id).toBeGreaterThan(0);

      const folders = await o().run<{ total: number; items: Array<{ name: string; id: number }> }>(
        "item.list",
        { type: "FolderItem" },
      );
      expect(folders.items.map((i) => i.name)).toContain("e2e_folder");

      const renamed = await o().run<{ id: number; name: string; warnings: string[] }>(
        "item.set_props",
        { item: "e2e_folder", name: "e2e_folder_renamed", comment: "written by the e2e suite" },
      );
      expect(renamed.name).toBe("e2e_folder_renamed");
      expect(renamed.warnings, "no property should have been rejected").toEqual([]);
      expect(renamed.id).toBe(folder.id);

      const moved = await o().run<{ item: string; folder: string }>("item.move_to_folder", {
        item: "test_comp",
        folder: "e2e_folder_renamed",
      });
      expect(moved.folder).toBe("e2e_folder_renamed");

      // The move is observable from the other side: scoping item.list to the
      // folder must now find the comp inside it.
      const inside = await o().run<{ items: Array<{ name: string }> }>("item.list", {
        folder: "e2e_folder_renamed",
      });
      expect(inside.items.map((i) => i.name)).toContain("test_comp");
    });
  });

  describe("fonts", () => {
    it("font.list returns the installed families", async (ctx) => {
      if (!ready) return ctx.skip();

      const fonts = await o().run<{
        total: number;
        returned: number;
        fonts: Array<{ postScriptName: string | null; familyName: string }>;
      }>("font.list", { limit: 5 });

      // Every AE install ships fonts, so a zero total is not "none installed"
      // — it is the app.fonts.allFonts shape assumption failing silently and
      // reporting success. That is exactly what this assertion guards.
      expect(fonts.total, "AE always has fonts; 0 means allFonts was misread").toBeGreaterThan(0);
      expect(fonts.fonts.length).toBeGreaterThan(0);
      expect(fonts.fonts.length).toBeLessThanOrEqual(5);
      expect(fonts.fonts[0]?.familyName).toBeTruthy();
    });

    it("font.list_missing answers consistently", async (ctx) => {
      if (!ready) return ctx.skip();

      const missing = await o().run<{ count: number; fonts: unknown[] }>("font.list_missing", {});
      expect(missing.count).toBe(missing.fonts.length);
    });
  });

  describe("viewer", () => {
    it("round-trips a view option through get_state", async (ctx) => {
      if (!ready) return ctx.skip();
      if (!viewerReady) return ctx.skip();

      const before = await o().run<{ zoom: number | null; type: string }>("viewer.get_state", {});
      if (before.zoom === null) return ctx.skip(); // no comp viewer options on this host

      await o().run("viewer.set_options", { zoom: 0.5 });
      const changed = await o().run<{ zoom: number | null }>("viewer.get_state", {});
      expect(changed.zoom).toBeCloseTo(0.5, 4);

      await o().run("viewer.set_options", { zoom: before.zoom });
      const restored = await o().run<{ zoom: number | null }>("viewer.get_state", {});
      expect(restored.zoom).toBeCloseTo(before.zoom, 4);
    });
  });

  describe("comp guides", () => {
    it("adds, moves, lists and removes a guide", async (ctx) => {
      if (!ready) return ctx.skip();

      const added = await o().run<{ guideIndex: number; numGuides: number }>("comp.add_guide", {
        comp: "test_comp",
        orientation: "vertical",
        position: 960,
      });
      expect(added.numGuides).toBeGreaterThan(0);

      const listed = await o().run<{
        count: number;
        guides: Array<{ index: number; orientation: string; position: number }>;
      }>("comp.list_guides", { comp: "test_comp" });
      expect(listed.count).toBe(added.numGuides);

      // Orientation and position must survive the round trip: add_guide writes
      // AE's 0/1 enum and list_guides reads it back, so a mismatch between the
      // two encodings shows up right here.
      const mine = listed.guides.find((g) => g.position === 960);
      expect(mine, "the guide we added should be listed at 960").toBeDefined();
      expect(mine?.orientation).toBe("vertical");

      await o().run("comp.set_guide", {
        comp: "test_comp",
        guideIndex: added.guideIndex,
        position: 480,
      });
      const afterMove = await o().run<{ guides: Array<{ position: number }> }>("comp.list_guides", {
        comp: "test_comp",
      });
      expect(afterMove.guides.map((g) => g.position)).toContain(480);
      expect(afterMove.guides.map((g) => g.position)).not.toContain(960);

      await o().run("comp.remove_guide", { comp: "test_comp", guideIndex: added.guideIndex });
      const afterRemove = await o().run<{ count: number }>("comp.list_guides", {
        comp: "test_comp",
      });
      expect(afterRemove.count).toBe(listed.count - 1);
    });
  });

  describe("essential graphics", () => {
    it("names a template, exposes a property, and lists the controller", async (ctx) => {
      if (!ready) return ctx.skip();

      const named = await o().run<{ name: string }>("egp.set_name", {
        comp: "test_comp",
        name: "e2e Template",
      });
      expect(named.name).toBe("e2e Template");

      // Opacity is the safe choice: every AVLayer has one, and it is a
      // supported Essential Graphics property type on every AE that has EGP.
      const added = await o().run<{
        property: string;
        controller: string | null;
        warning?: string;
      }>("egp.add_property", {
        comp: "test_comp",
        layer: "red_layer",
        property: ["Transform", "Opacity"],
        controllerName: "Red Opacity",
      });
      expect(added.property).toBeTruthy();
      // Either the rename applied, or the op said it could not — never a name
      // reported back that AE did not actually set.
      if (added.controller === null) {
        expect(added.warning, "an ignored controllerName must be reported").toBeTruthy();
      } else {
        expect(added.controller).toBe("Red Opacity");
      }

      const controllers = await o().run<{
        templateName: string | null;
        count: number;
        controllers: unknown[];
      }>("egp.list_controllers", { comp: "test_comp" });
      expect(controllers.templateName).toBe("e2e Template");
      expect(controllers.count).toBeGreaterThan(0);
      expect(controllers.controllers.length).toBe(controllers.count);
    });
  });

  describe("file-backed footage", () => {
    it("imports a generated PNG, reinterprets it, and sets then clears a proxy", async (ctx) => {
      if (!ready) return ctx.skip();

      // Generated with the server's own encoder rather than shipped as a
      // fixture: the suite stays self-contained and the file is guaranteed to
      // be a valid sRGB-tagged PNG that AE will accept.
      await fs.mkdir(E2E_SCRATCH_DIR, { recursive: true });
      const pngPath = path.join(E2E_SCRATCH_DIR, "e2e_footage.png").replace(/\\/g, "/");
      await fs.writeFile(pngPath, encodePngSrgb8(8, 8, new Float64Array(8 * 8 * 3).fill(0.5)));

      const imported = await o().run<{ id: number; name: string }>("project.import_file", {
        path: pngPath,
        name: "e2e_png",
      });
      expect(imported.name).toBe("e2e_png");

      const interpreted = await o().run<{ name: string; warnings: string[] }>("footage.interpret", {
        item: "e2e_png",
        alphaMode: "ignore",
        pixelAspect: 1,
      });
      expect(interpreted.name).toBe("e2e_png");
      expect(interpreted.warnings, "AE rejected an interpretation setting").toEqual([]);

      const proxied = await o().run<{ name: string; useProxy: boolean; proxy: string | null }>(
        "footage.set_proxy",
        { item: "e2e_png", path: pngPath },
      );
      expect(proxied.useProxy).toBe(true);
      expect(proxied.proxy).toBeTruthy();

      const cleared = await o().run<{ proxy: string | null }>("footage.set_proxy", {
        item: "e2e_png",
      });
      expect(cleared.proxy).toBeNull();
    });
  });

  describe("undo", () => {
    it("reverts the previous call, whole", async (ctx) => {
      if (!ready) return ctx.skip();

      // Only AE can answer this one. project.undo runs OUTSIDE the dispatcher's
      // undo group: wrapped in one, AE resolves each Undo against that still-open
      // group and the call being undone survives — which is exactly what this
      // asserts does not happen.
      const before = await o().run<{ layers: unknown[] }>("comp.info", { comp: "test_comp" });

      await o().run("batch.run", {
        ops: [
          { operation: "layer.create_null", args: { comp: "test_comp", name: "e2e_undo_a" } },
          { operation: "layer.create_null", args: { comp: "test_comp", name: "e2e_undo_b" } },
        ],
      });
      const added = await o().run<{ layers: Array<{ name: string }> }>("comp.info", {
        comp: "test_comp",
      });
      expect(added.layers).toHaveLength(before.layers.length + 2);

      const undone = await o().run<{ ok: boolean; undone: number }>("project.undo", { count: 1 });
      expect(undone.undone).toBe(1);

      // One batch = one undo step: both layers are gone, and nothing older is.
      const after = await o().run<{ layers: Array<{ name: string }> }>("comp.info", {
        comp: "test_comp",
      });
      expect(after.layers).toHaveLength(before.layers.length);
      expect(after.layers.map((l) => l.name)).not.toContain("e2e_undo_a");
      expect(after.layers.map((l) => l.name)).not.toContain("e2e_undo_b");
    });
  });
});
