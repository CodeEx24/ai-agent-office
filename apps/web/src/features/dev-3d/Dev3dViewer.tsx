"use client";

import { Suspense, useEffect, useState } from "react";
import { Canvas } from "@react-three/fiber";
import { OrbitControls, useAnimations, useGLTF } from "@react-three/drei";
import { Button } from "@ago/ui";

import { type ClipKind, type ModelStats, collectModelStats, findClipName } from "./model-stats";

interface ModelProps {
  url: string;
  clip: ClipKind;
  onStats: (stats: ModelStats) => void;
}

function Model({ url, clip, onStats }: ModelProps) {
  const { scene, animations } = useGLTF(url);
  const { actions, names } = useAnimations(animations, scene);

  useEffect(() => {
    onStats(collectModelStats(scene, animations));
    // Skinned bounds come from the bind pose, so a walking mesh can be culled wrongly; fine for a spike viewer.
    scene.traverse((object) => {
      object.frustumCulled = false;
    });
  }, [scene, animations, onStats]);

  useEffect(() => {
    const clipName = findClipName(names, clip);
    const action = clipName ? actions[clipName] : null;
    action?.reset().fadeIn(0.2).play();
    return () => {
      action?.fadeOut(0.2);
    };
  }, [actions, names, clip]);

  return <primitive object={scene} />;
}

export interface Dev3dViewerProps {
  modelUrl: string;
}

/** Client-only R3F viewer: loads one GLB and lets the tester switch between its idle and walk clips. */
export function Dev3dViewer({ modelUrl }: Dev3dViewerProps) {
  const [clip, setClip] = useState<ClipKind>("idle");
  const [stats, setStats] = useState<ModelStats | null>(null);

  return (
    <div className="flex flex-col gap-4" data-testid="dev-3d-viewer">
      <div className="flex gap-2" role="group" aria-label="Animation clip">
        {(["idle", "walk"] as const).map((kind) => (
          <Button
            key={kind}
            variant={clip === kind ? "default" : "outline"}
            aria-pressed={clip === kind}
            onClick={() => {
              setClip(kind);
            }}
          >
            {kind === "idle" ? "Idle" : "Walk"}
          </Button>
        ))}
      </div>
      <div className="h-[28rem] w-full overflow-hidden rounded-lg border">
        <Canvas camera={{ position: [0, 1, 3], fov: 40 }} dpr={[1, 2]}>
          <hemisphereLight args={["#BFE3FF", "#F2C9A0", 0.7]} />
          <directionalLight position={[-2, 3, 3]} color="#FFF3E0" intensity={1} />
          <directionalLight position={[0, 2, -3]} color="#9FF3EA" intensity={0.4} />
          <Suspense fallback={null}>
            <Model url={modelUrl} clip={clip} onStats={setStats} />
          </Suspense>
          <OrbitControls target={[0, 0.5, 0]} />
        </Canvas>
      </div>
      <dl className="grid grid-cols-2 gap-2 text-sm" data-testid="dev-3d-stats">
        <dt>Triangles</dt>
        <dd>{stats?.triangles ?? "loading"}</dd>
        <dt>Bones</dt>
        <dd>{stats?.bones ?? "loading"}</dd>
        <dt>Clips</dt>
        <dd>{stats?.clips.join(", ") ?? "loading"}</dd>
        <dt>Textures</dt>
        <dd>
          {stats?.textures.map((t) => `${String(t.width)}x${String(t.height)}`).join(", ") ??
            "loading"}
        </dd>
      </dl>
    </div>
  );
}
