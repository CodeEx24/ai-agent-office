"use client";

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { OrbitControls, useAnimations, useGLTF } from "@react-three/drei";
import type { AnimationAction } from "three";
import { clone as cloneSkinned } from "three/addons/utils/SkeletonUtils.js";
import { Button } from "@ago/ui";

import { type CrowdCharacter, type CrowdSlot, getCrowdSlots } from "./crowd-layout";
import { FrameWindow, type FrameSummary } from "./frame-stats";

export const CROWD_CLIPS = ["Idle", "Walk", "Talk"] as const;
export type CrowdClip = (typeof CROWD_CLIPS)[number];

const CROWD_SIZE = 8;
const MODEL_URLS: Record<CrowdCharacter, string> = {
  pixel: "/models/spike-pixel.glb",
  mannequin: "/models/spike-mannequin.glb",
};

/** What each character reports to the test bridge: which clip its mixer is actually running. */
export interface ActiveClipReport {
  id: string;
  character: CrowdCharacter;
  clip: string | null;
  isRunning: boolean;
}

/** Read-only handle for Playwright and the FPS measurement script. */
export interface CrowdPerfBridge {
  summary: () => FrameSummary;
  reset: () => void;
  renderer: string;
  drawCalls: () => number;
  triangles: () => number;
  activeClips: () => ActiveClipReport[];
}

declare global {
  interface Window {
    __crowdPerf?: CrowdPerfBridge;
  }
}

type Reporters = Map<string, () => ActiveClipReport>;

interface CrowdMemberProps {
  slot: CrowdSlot;
  clip: CrowdClip;
  reporters: Reporters;
}

/** Fades a clip in and starts it part-way through, so the crowd is not in lockstep. */
function playFromPhase(action: AnimationAction, phase: number): void {
  action.reset().fadeIn(0.2).play();
  action.time = phase * action.getClip().duration;
}

function CrowdMember({ slot, clip, reporters }: CrowdMemberProps) {
  const { scene, animations } = useGLTF(MODEL_URLS[slot.character], false);
  // SkeletonUtils.clone gives every member its own skeleton while sharing geometry and materials.
  const instance = useMemo(() => cloneSkinned(scene), [scene]);
  const { actions } = useAnimations(animations, instance);

  useEffect(() => {
    // Skinned bounds come from the bind pose, so a moving mesh can be culled wrongly.
    instance.traverse((object) => {
      object.frustumCulled = false;
    });
  }, [instance]);

  useEffect(() => {
    const action = actions[clip];
    if (action) playFromPhase(action, slot.phase);
    return () => {
      action?.fadeOut(0.2);
    };
  }, [actions, clip, slot.phase]);

  useEffect(() => {
    reporters.set(slot.id, () => {
      const running = Object.entries(actions).find(
        ([, action]) => action?.isRunning() && action.getEffectiveWeight() > 0.5,
      );
      return {
        id: slot.id,
        character: slot.character,
        clip: running?.[0] ?? null,
        isRunning: running !== undefined,
      };
    });
    return () => {
      reporters.delete(slot.id);
    };
  }, [actions, reporters, slot.character, slot.id]);

  return <primitive object={instance} position={slot.position} />;
}

interface PerfProbeProps {
  readoutRef: React.RefObject<HTMLElement | null>;
  reporters: Reporters;
}

function readRendererName(gl: WebGLRenderingContext | WebGL2RenderingContext): string {
  const extension = gl.getExtension("WEBGL_debug_renderer_info");
  const name = extension ? (gl.getParameter(extension.UNMASKED_RENDERER_WEBGL) as unknown) : null;
  return typeof name === "string" ? name : "unknown";
}

/** Samples frame times inside the render loop and publishes them, without re-rendering React. */
function PerfProbe({ readoutRef, reporters }: PerfProbeProps) {
  const renderer = useThree((state) => state.gl);
  const frames = useRef(new FrameWindow(600));
  const sinceUpdate = useRef(0);

  useEffect(() => {
    const bridge: CrowdPerfBridge = {
      summary: () => frames.current.summary(),
      reset: () => {
        frames.current.clear();
      },
      renderer: readRendererName(renderer.getContext()),
      drawCalls: () => renderer.info.render.calls,
      triangles: () => renderer.info.render.triangles,
      activeClips: () => [...reporters.values()].map((report) => report()),
    };
    window.__crowdPerf = bridge;
    return () => {
      delete window.__crowdPerf;
    };
  }, [renderer, reporters]);

  useFrame((_, delta) => {
    frames.current.push(delta * 1000);
    sinceUpdate.current += delta;
    if (sinceUpdate.current < 0.5) return;
    sinceUpdate.current = 0;
    const summary = frames.current.summary();
    const element = readoutRef.current;
    if (!element) return;
    element.dataset.fps = summary.fps.toFixed(1);
    element.textContent = `${summary.fps.toFixed(0)} fps, ${summary.avgFrameMs.toFixed(1)} ms avg, ${summary.p95FrameMs.toFixed(1)} ms p95, ${String(renderer.info.render.calls)} draw calls, ${String(renderer.info.render.triangles)} triangles`;
  });

  return null;
}

/** Dev-only crowd: 8 animated characters (4 Pixel, 4 Mannequin) on one shared bone contract, with an FPS readout. */
export function CrowdViewer() {
  const [clip, setClip] = useState<CrowdClip>("Idle");
  const slots = useMemo(() => getCrowdSlots(CROWD_SIZE), []);
  const readoutRef = useRef<HTMLElement | null>(null);
  const [reporters] = useState<Reporters>(() => new Map());
  const setReadout = useCallback((element: HTMLElement | null) => {
    readoutRef.current = element;
  }, []);

  return (
    <div className="flex flex-col gap-4" data-testid="crowd-viewer">
      <div className="flex gap-2" role="group" aria-label="Animation clip">
        {CROWD_CLIPS.map((name) => (
          <Button
            key={name}
            variant={clip === name ? "default" : "outline"}
            aria-pressed={clip === name}
            onClick={() => {
              setClip(name);
            }}
          >
            {name}
          </Button>
        ))}
      </div>
      <div className="h-[30rem] w-full overflow-hidden rounded-lg border">
        <Canvas camera={{ position: [0, 1.7, 5.4], fov: 38 }} dpr={[1, 2]}>
          <hemisphereLight args={["#BFE3FF", "#F2C9A0", 0.7]} />
          <directionalLight position={[-2, 3, 3]} color="#FFF3E0" intensity={1} />
          <directionalLight position={[0, 2, -3]} color="#9FF3EA" intensity={0.4} />
          <Suspense fallback={null}>
            {slots.map((slot) => (
              <CrowdMember key={slot.id} slot={slot} clip={clip} reporters={reporters} />
            ))}
          </Suspense>
          <PerfProbe readoutRef={readoutRef} reporters={reporters} />
          <OrbitControls target={[0, 0.5, 0]} />
        </Canvas>
      </div>
      <p className="font-mono text-sm" data-testid="crowd-fps" ref={setReadout} aria-live="off">
        measuring...
      </p>
      <p className="text-sm" data-testid="crowd-count">
        {slots.length} characters: {slots.filter((slot) => slot.character === "pixel").length}{" "}
        Pixel, {slots.filter((slot) => slot.character === "mannequin").length} Mannequin
      </p>
    </div>
  );
}
