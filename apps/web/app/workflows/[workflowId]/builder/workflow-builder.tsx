"use client";

import { useMemo, useState } from "react";
import type { WorkflowVersionSummary } from "@harbor/api";
import type { WorkflowDefinition, WorkflowNode, WorkflowNodeType } from "@harbor/harness";
import {
  Background,
  Controls,
  MarkerType,
  MiniMap,
  ReactFlow,
  type Edge,
  type Node
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { saveAndPublishWorkflowAction, saveWorkflowDraftAction } from "./actions";

interface WorkflowBuilderProps {
  initialWorkflow: WorkflowDefinition;
  versions: WorkflowVersionSummary[];
}

const nodeTypeColors: Record<WorkflowNodeType, string> = {
  planner: "#2E90FA",
  executor: "#16A34A",
  verifier: "#CA8A04",
  memory_write: "#0F766E",
  tool_call: "#9333EA"
};

function toFlowNodes(workflowNodes: WorkflowNode[], previous?: Node[]): Node[] {
  const positionByNodeId = new Map(previous?.map((node) => [node.id, node.position]));

  return workflowNodes.map((node, index) => ({
    id: node.id,
    position: positionByNodeId.get(node.id) ?? { x: 80 + index * 250, y: 120 + (index % 2) * 160 },
    data: {
      label: (
        <div style={{ lineHeight: 1.2 }}>
          <div style={{ fontSize: 12, opacity: 0.7, textTransform: "uppercase", letterSpacing: "0.05em" }}>
            {node.type}
          </div>
          <div style={{ fontWeight: 700 }}>{node.label ?? node.id}</div>
          <div style={{ fontSize: 12 }}>owner: {node.owner ?? "unowned"}</div>
          <div style={{ fontSize: 12 }}>
            {node.timeoutMs ?? 0}ms · retry {node.retryLimit ?? 0}
          </div>
        </div>
      )
    },
    style: {
      border: `2px solid ${nodeTypeColors[node.type]}`,
      borderRadius: 12,
      width: 220,
      background: "#ffffff",
      boxShadow: "0 12px 22px rgba(15, 23, 42, 0.08)"
    }
  }));
}

function toFlowEdges(workflowNodes: WorkflowNode[]): Edge[] {
  if (workflowNodes.length < 2) {
    return [];
  }

  return workflowNodes.slice(1).map((node, index) => ({
    id: `${workflowNodes[index]?.id ?? "unknown"}-${node.id}`,
    source: workflowNodes[index]?.id ?? "",
    target: node.id,
    type: "smoothstep",
    markerEnd: {
      type: MarkerType.ArrowClosed
    }
  }));
}

function nextNodeId(nodes: WorkflowNode[]): string {
  return `node_${nodes.length + 1}`;
}

export function WorkflowBuilder({ initialWorkflow, versions }: WorkflowBuilderProps) {
  const [workflow, setWorkflow] = useState<WorkflowDefinition>(initialWorkflow);
  const [newNodeType, setNewNodeType] = useState<WorkflowNodeType>("executor");

  const [flowNodes, setFlowNodes] = useState<Node[]>(() => toFlowNodes(initialWorkflow.nodes));
  const flowEdges = useMemo(() => toFlowEdges(workflow.nodes), [workflow.nodes]);
  const workflowJson = useMemo(() => JSON.stringify(workflow), [workflow]);

  function syncNodes(nextNodes: WorkflowNode[]): void {
    setFlowNodes((previous) => toFlowNodes(nextNodes, previous));
    setWorkflow((previous) => ({
      ...previous,
      nodes: nextNodes
    }));
  }

  function updateNodeField(index: number, patch: Partial<WorkflowNode>): void {
    const nextNodes = workflow.nodes.map((node, currentIndex) => (currentIndex === index ? { ...node, ...patch } : node));
    syncNodes(nextNodes);
  }

  function addNode(): void {
    const createdNode: WorkflowNode = {
      id: nextNodeId(workflow.nodes),
      type: newNodeType,
      label: `${newNodeType} node`,
      owner: "builder",
      timeoutMs: 1_000,
      retryLimit: 1
    };

    syncNodes([...workflow.nodes, createdNode]);
  }

  function removeNode(nodeId: string): void {
    if (workflow.nodes.length <= 1) {
      return;
    }

    syncNodes(workflow.nodes.filter((node) => node.id !== nodeId));
  }

  return (
    <section style={{ display: "grid", gap: 20 }}>
      <section
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))",
          gap: 12,
          background:
            "radial-gradient(circle at 20% 20%, rgba(37, 99, 235, 0.18), transparent 45%), linear-gradient(135deg, #0f172a, #111827)",
          borderRadius: 16,
          color: "#f8fafc",
          padding: 16
        }}
      >
        <div>
          <div style={{ opacity: 0.8, fontSize: 12, textTransform: "uppercase", letterSpacing: "0.06em" }}>Workflow</div>
          <div style={{ fontSize: 20, fontWeight: 700 }}>{workflow.name}</div>
          <div style={{ fontSize: 13, opacity: 0.85 }}>ID: {workflow.id}</div>
        </div>
        <div>
          <div style={{ opacity: 0.8, fontSize: 12, textTransform: "uppercase", letterSpacing: "0.06em" }}>Current Draft</div>
          <div style={{ fontSize: 20, fontWeight: 700 }}>v{workflow.version}</div>
          <div style={{ fontSize: 13, opacity: 0.85 }}>{workflow.nodes.length} nodes</div>
        </div>
        <div style={{ display: "grid", gap: 8, alignContent: "center" }}>
          <form action={saveWorkflowDraftAction}>
            <input type="hidden" name="workflowId" value={workflow.id} />
            <input type="hidden" name="workflowJson" value={workflowJson} />
            <button type="submit" style={{ width: "100%", padding: "10px 12px", fontWeight: 700 }}>
              Save Draft
            </button>
          </form>
          <form action={saveAndPublishWorkflowAction}>
            <input type="hidden" name="workflowId" value={workflow.id} />
            <input type="hidden" name="workflowJson" value={workflowJson} />
            <button type="submit" style={{ width: "100%", padding: "10px 12px", fontWeight: 700 }}>
              Save + Publish
            </button>
          </form>
        </div>
      </section>

      <section style={{ display: "grid", gap: 12 }}>
        <label style={{ display: "grid", gap: 6 }}>
          <span style={{ fontWeight: 600 }}>Workflow Name</span>
          <input
            value={workflow.name}
            onChange={(event) => setWorkflow({ ...workflow, name: event.target.value })}
            style={{ padding: 8 }}
          />
        </label>
        <label style={{ display: "grid", gap: 6 }}>
          <span style={{ fontWeight: 600 }}>Objective</span>
          <textarea
            value={workflow.objective}
            onChange={(event) => setWorkflow({ ...workflow, objective: event.target.value })}
            rows={2}
            style={{ padding: 8 }}
          />
        </label>
        <label style={{ display: "grid", gap: 6 }}>
          <span style={{ fontWeight: 600 }}>System Prompt</span>
          <textarea
            value={workflow.systemPrompt}
            onChange={(event) => setWorkflow({ ...workflow, systemPrompt: event.target.value })}
            rows={3}
            style={{ padding: 8 }}
          />
        </label>
        <label style={{ display: "grid", gap: 6, maxWidth: 240 }}>
          <span style={{ fontWeight: 600 }}>Version</span>
          <input
            type="number"
            min={1}
            value={workflow.version}
            onChange={(event) => setWorkflow({ ...workflow, version: Number(event.target.value) || 1 })}
            style={{ padding: 8 }}
          />
        </label>
      </section>

      <section
        style={{
          border: "1px solid #dbe3ef",
          borderRadius: 14,
          overflow: "hidden",
          height: 520,
          background: "linear-gradient(180deg, #eff6ff 0%, #ffffff 70%)"
        }}
      >
        <ReactFlow nodes={flowNodes} edges={flowEdges} fitView>
          <MiniMap />
          <Controls />
          <Background />
        </ReactFlow>
      </section>

      <section style={{ border: "1px solid #e5e7eb", borderRadius: 12, padding: 14 }}>
        <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 12 }}>
          <select
            value={newNodeType}
            onChange={(event) => setNewNodeType(event.target.value as WorkflowNodeType)}
            style={{ padding: 8 }}
          >
            <option value="planner">planner</option>
            <option value="executor">executor</option>
            <option value="verifier">verifier</option>
            <option value="memory_write">memory_write</option>
            <option value="tool_call">tool_call</option>
          </select>
          <button type="button" onClick={addNode} style={{ padding: "8px 12px" }}>
            Add Node
          </button>
        </div>
        <div style={{ display: "grid", gap: 10 }}>
          {workflow.nodes.map((node, index) => (
            <article key={node.id} style={{ border: "1px solid #dbe3ef", borderRadius: 10, padding: 10 }}>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 8 }}>
                <label style={{ display: "grid", gap: 4 }}>
                  <span>ID</span>
                  <input
                    value={node.id}
                    onChange={(event) => updateNodeField(index, { id: event.target.value })}
                    style={{ padding: 6 }}
                  />
                </label>
                <label style={{ display: "grid", gap: 4 }}>
                  <span>Label</span>
                  <input
                    value={node.label ?? ""}
                    onChange={(event) => updateNodeField(index, { label: event.target.value })}
                    style={{ padding: 6 }}
                  />
                </label>
                <label style={{ display: "grid", gap: 4 }}>
                  <span>Owner</span>
                  <input
                    value={node.owner ?? ""}
                    onChange={(event) => updateNodeField(index, { owner: event.target.value })}
                    style={{ padding: 6 }}
                  />
                </label>
                <label style={{ display: "grid", gap: 4 }}>
                  <span>Timeout (ms)</span>
                  <input
                    type="number"
                    min={1}
                    value={node.timeoutMs ?? 1_000}
                    onChange={(event) => updateNodeField(index, { timeoutMs: Number(event.target.value) || 1_000 })}
                    style={{ padding: 6 }}
                  />
                </label>
                <label style={{ display: "grid", gap: 4 }}>
                  <span>Retry Limit</span>
                  <input
                    type="number"
                    min={0}
                    value={node.retryLimit ?? 0}
                    onChange={(event) => updateNodeField(index, { retryLimit: Number(event.target.value) || 0 })}
                    style={{ padding: 6 }}
                  />
                </label>
              </div>
              <button type="button" onClick={() => removeNode(node.id)} style={{ marginTop: 8, padding: "6px 10px" }}>
                Remove Node
              </button>
            </article>
          ))}
        </div>
      </section>

      <section style={{ border: "1px solid #e5e7eb", borderRadius: 12, padding: 14 }}>
        <h2 style={{ marginTop: 0 }}>Saved Versions</h2>
        {versions.length === 0 ? (
          <p>No saved versions yet.</p>
        ) : (
          <table style={{ borderCollapse: "collapse", width: "100%" }}>
            <thead>
              <tr>
                <th style={{ textAlign: "left", borderBottom: "1px solid #d1d5db", padding: "6px 4px" }}>Version</th>
                <th style={{ textAlign: "left", borderBottom: "1px solid #d1d5db", padding: "6px 4px" }}>State</th>
                <th style={{ textAlign: "left", borderBottom: "1px solid #d1d5db", padding: "6px 4px" }}>Saved By</th>
                <th style={{ textAlign: "left", borderBottom: "1px solid #d1d5db", padding: "6px 4px" }}>Saved At</th>
              </tr>
            </thead>
            <tbody>
              {versions.map((version) => (
                <tr key={`${version.workflowId}:${version.version}`}>
                  <td style={{ padding: "6px 4px" }}>v{version.version}</td>
                  <td style={{ padding: "6px 4px" }}>{version.state}</td>
                  <td style={{ padding: "6px 4px" }}>{version.savedBy}</td>
                  <td style={{ padding: "6px 4px" }}>{new Date(version.savedAt).toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </section>
  );
}
