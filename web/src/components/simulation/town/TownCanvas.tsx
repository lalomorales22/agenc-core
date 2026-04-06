/**
 * PixiJS Application wrapper using imperative useEffect pattern.
 * Manages WebGL context lifecycle — destroys on unmount to prevent leaks.
 */

import { useEffect, useRef } from 'react';
import { Application, Assets, Texture } from 'pixi.js';
import type { ParsedMap } from './maps/types';
import { createTilemapContainer } from './layers/TilemapLayer';
import { AgentLayerManager } from './layers/AgentLayer';
import type { AgentVisualState } from './hooks/useTownState';
import type { VisualCommand } from './systems/EventInterpreter';

interface TownCanvasProps {
  parsedMap: ParsedMap | null;
  agents: AgentVisualState[];
  commands: VisualCommand[];
  onAgentPositionsUpdate: (
    positions: Map<string, { x: number; y: number; locationId: string | null }>,
  ) => void;
  onAgentClick?: (agentId: string) => void;
}

export function TownCanvas({
  parsedMap,
  agents,
  commands,
  onAgentPositionsUpdate,
  onAgentClick,
}: TownCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const appRef = useRef<Application | null>(null);
  const agentLayerRef = useRef<AgentLayerManager | null>(null);
  const agentsRef = useRef<AgentVisualState[]>(agents);
  const commandsRef = useRef<VisualCommand[]>(commands);
  const onPositionsUpdateRef = useRef(onAgentPositionsUpdate);
  const onAgentClickRef = useRef(onAgentClick);
  const processedCommandsRef = useRef(new Set<string>());

  agentsRef.current = agents;
  commandsRef.current = commands;
  onPositionsUpdateRef.current = onAgentPositionsUpdate;
  onAgentClickRef.current = onAgentClick;

  useEffect(() => {
    if (!canvasRef.current || !parsedMap) return;

    const canvas = canvasRef.current;
    const app = new Application();
    let destroyed = false;

    app
      .init({
        canvas,
        width: parsedMap.pixelWidth,
        height: parsedMap.pixelHeight,
        backgroundColor: 0x1a1a2e,
        antialias: false,
        resolution: 1,
        autoDensity: true,
      })
      .then(async () => {
        if (destroyed) return;
        appRef.current = app;

        // Load tileset textures
        const tilesetTextures = new Map<string, Texture>();
        for (const ts of parsedMap.tilesets) {
          try {
            const texture = await Assets.load<Texture>(ts.image);
            tilesetTextures.set(ts.name, texture);
          } catch {
            console.warn(`Failed to load tileset: ${ts.image}`);
          }
        }

        if (destroyed) return;

        // Try to load agent spritesheet
        let agentSpritesheet: Texture | undefined;
        try {
          agentSpritesheet = await Assets.load<Texture>('/assets/sprites/agents/agent-default.png');
        } catch {
          // No spritesheet available — AgentSprite falls back to circles
        }

        if (destroyed) return;

        // Create tilemap layer
        const tilemapContainer = createTilemapContainer(parsedMap, tilesetTextures);
        app.stage.addChild(tilemapContainer);

        // Create agent layer
        const agentLayer = new AgentLayerManager(agentSpritesheet);
        agentLayerRef.current = agentLayer;
        agentLayer.setOnAgentClick((agentId) => {
          onAgentClickRef.current?.(agentId);
        });
        app.stage.addChild(agentLayer.container);

        // Fit map to canvas viewport
        fitToViewport(app, parsedMap);

        // Animation tick
        app.ticker.add((ticker) => {
          if (destroyed || !agentLayerRef.current) return;
          agentLayerRef.current.update(agentsRef.current, ticker.deltaTime);

          // Process new visual commands (speech bubbles)
          for (const cmd of commandsRef.current) {
            const key = `${cmd.agentName}:${cmd.type}:${cmd.text ?? ''}`;
            if (!processedCommandsRef.current.has(key)) {
              processedCommandsRef.current.add(key);
              if ((cmd.type === 'speech' || cmd.type === 'action') && cmd.text) {
                // Find agent by name match
                for (const agent of agentsRef.current) {
                  if (agent.name === cmd.agentName) {
                    agentLayerRef.current.showSpeech(agent.agentId, cmd.text, cmd.duration);
                    break;
                  }
                }
              }
              // Prevent unbounded growth of processed set
              if (processedCommandsRef.current.size > 200) {
                const entries = [...processedCommandsRef.current];
                processedCommandsRef.current = new Set(entries.slice(-100));
              }
            }
          }

          // Report positions back
          const positions = new Map<
            string,
            { x: number; y: number; locationId: string | null }
          >();
          for (const agent of agentsRef.current) {
            positions.set(agent.agentId, {
              x: agent.targetX,
              y: agent.targetY,
              locationId: agent.locationId,
            });
          }
          onPositionsUpdateRef.current(positions);
        });
      })
      .catch((err) => {
        if (!destroyed) console.error('PixiJS init failed:', err);
      });

    return () => {
      destroyed = true;
      agentLayerRef.current?.destroy();
      agentLayerRef.current = null;
      if (appRef.current) {
        appRef.current.destroy(true);
        appRef.current = null;
      }
    };
  }, [parsedMap]);

  return (
    <canvas
      ref={canvasRef}
      style={{ width: '100%', height: '100%', imageRendering: 'pixelated' }}
    />
  );
}

function fitToViewport(app: Application, parsed: ParsedMap): void {
  const parent = app.canvas.parentElement;
  if (!parent) return;

  const scaleX = parent.clientWidth / parsed.pixelWidth;
  const scaleY = parent.clientHeight / parsed.pixelHeight;
  const scale = Math.min(scaleX, scaleY, 2);

  app.stage.scale.set(scale);

  const offsetX = (parent.clientWidth - parsed.pixelWidth * scale) / 2;
  const offsetY = (parent.clientHeight - parsed.pixelHeight * scale) / 2;
  app.stage.x = offsetX;
  app.stage.y = offsetY;

  app.renderer.resize(parent.clientWidth, parent.clientHeight);
}
