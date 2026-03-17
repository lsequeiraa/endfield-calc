import type { Node, Edge } from "@xyflow/react";
import type {
  Item,
  ItemId,
  Facility,
  ProductionDependencyGraph,
  ProductionGraphNode,
  FlowNodeData,
  FlowProductionNode,
  FlowTargetNode,
  FlowDisposalNode,
} from "@/types";
import {
  createEdge,
  createProductionFlowNode,
  createTargetSinkNode,
  createDisposalSinkNode,
} from "../flow/flow-utils";
import { createTargetSinkId, createRawMaterialId } from "@/lib/node-keys";
import { calcRate } from "@/lib/utils";
import { getRecipeOutputItemId, getRecipeInputItemId, getItemProducers, isRecipeTerminal } from "@/lib/plan-helpers";

/**
 * Maps a ProductionDependencyGraph to React Flow nodes and edges in merged mode.
 */
export function mapPlanToFlowMerged(
  plan: ProductionDependencyGraph,
  items: Item[],
  facilities: Facility[],
  targetRates?: Map<ItemId, number>,
  ceilMode = false,
): { nodes: (FlowProductionNode | FlowTargetNode | FlowDisposalNode)[]; edges: Edge[] } {
  const flowNodes: Node<FlowNodeData>[] = [];
  const flowEdges: Edge[] = [];
  const targetSinkNodes: FlowTargetNode[] = [];

  let edgeIdCounter = 0;

  // Pre-calculate which items are upstream (have consumers)
  const upstreamItemIds = new Set<string>();
  plan.edges.forEach((edge) => {
    if (plan.nodes.get(edge.from)?.type === "item") {
      upstreamItemIds.add(edge.from);
    }
  });

  // Create production nodes (recipe nodes only)
  plan.nodes.forEach((node, nodeId) => {
    if (node.type === "recipe") {
      const outputItemId = getRecipeOutputItemId(plan, nodeId);
      const outputItemNode = outputItemId
        ? (plan.nodes.get(outputItemId) as
          | Extract<ProductionGraphNode, { type: "item" }>
          | undefined)
        : undefined;

      // Skip recipe node if it's a terminal target (has no consumers and
      // no secondary outputs feeding into other recipes). Multi-output recipes
      // that participate in cycles must NOT be skipped.
      if (outputItemNode && !isRecipeTerminal(plan, nodeId)) {
        flowNodes.push(
           createProductionFlowNode(
            nodeId,
            {
              item: outputItemNode.item,
              targetRate: outputItemNode.productionRate,
              recipe: node.recipe,
              facility: node.facility,
              facilityCount: node.facilityCount,
              isRawMaterial: false,
              isTarget: outputItemNode.isTarget,
              dependencies: [],
            },
            items,
            facilities,
            ceilMode,
            {
              isDirectTarget: outputItemNode.isTarget,
              directTargetRate: outputItemNode.isTarget
                ? (targetRates?.get(outputItemNode.itemId) ??
                    outputItemNode.productionRate)
                : undefined,
            },
          ),
        );
      }
    }
  });

  // Create edges: Recipe → Item → Recipe
  plan.edges.forEach((edge) => {
    const sourceNode = plan.nodes.get(edge.from);
    const targetNode = plan.nodes.get(edge.to);

    if (!sourceNode || !targetNode) return;

    // Recipe → Item (produce)
    if (sourceNode.type === "recipe" && targetNode.type === "item") {
      // Don't create visible edge, just track the relationship
      return;
    }

    // Item → Recipe (consume)
    if (sourceNode.type === "item" && targetNode.type === "recipe") {
      // Skip disposal recipe edges — disposal sinks create their own edges
      if (targetNode.isDisposal) return;

      // Find ALL recipes that produce this item (handles multi-producer items
      // like liquid_sewage produced by both pool_xiranite_poly_1 and furnace)
      const producers = getItemProducers(plan, edge.from);

      // Determine where this flow should end
      const isTerminalTargetRecipe = isRecipeTerminal(plan, edge.to);

      let flowTargetId = edge.to;
      if (isTerminalTargetRecipe) {
        const outputItemId = getRecipeOutputItemId(plan, edge.to);
        const outputNode = outputItemId ? plan.nodes.get(outputItemId) : undefined;
        if (outputNode?.type === "item") {
          flowTargetId = createTargetSinkId(outputNode.itemId);
        }
      }

      // Calculate total consumption rate
      const inputAmount =
        targetNode.recipe.inputs.find(
          (inp) => inp.itemId === sourceNode.itemId,
        )?.amount || 0;
      const totalFlowRate =
        calcRate(inputAmount, targetNode.recipe.craftingTime) *
        targetNode.facilityCount;

      if (producers.length > 0) {
        // Split flow across all producers proportionally
        const totalProduction = producers.reduce((sum, p) => sum + p.rate, 0);

        for (const producer of producers) {
          const edgeFlowRate =
            totalProduction > 0
              ? totalFlowRate * (producer.rate / totalProduction)
              : totalFlowRate / producers.length;

          flowEdges.push(
            createEdge(
              `e${edgeIdCounter++}`,
              producer.recipeId,
              flowTargetId,
              edgeFlowRate,
              sourceNode.item,
              undefined,
              ceilMode,
            ),
          );
        }
      } else if (sourceNode.isRawMaterial) {
        // Raw material → Recipe: create node for raw material
        const rawMaterialNodeId = createRawMaterialId(sourceNode.itemId);

        if (!flowNodes.find((n) => n.id === rawMaterialNodeId)) {
          flowNodes.push(
            createProductionFlowNode(
              rawMaterialNodeId,
              {
                item: sourceNode.item,
                targetRate: sourceNode.productionRate,
                recipe: null,
                facility: null,
                facilityCount: 0,
                isRawMaterial: true,
                isTarget: false,
                dependencies: [],
              },
              items,
              facilities,
              ceilMode,
              { isDirectTarget: false },
            ),
          );
        }

        flowEdges.push(
          createEdge(
            `e${edgeIdCounter++}`,
            rawMaterialNodeId,
            flowTargetId,
            totalFlowRate,
            sourceNode.item,
            undefined,
            ceilMode,
          ),
        );
      }
    }
  });

  // Create target sink nodes
  plan.nodes.forEach((node, nodeId) => {
    if (node.type === "item" && node.isTarget && !node.isRawMaterial) {
      const targetNodeId = createTargetSinkId(node.itemId);

      // Find ALL recipes producing this target item
      const producers = getItemProducers(plan, nodeId);

      const isTerminalTarget = !upstreamItemIds.has(nodeId);

      // Check if ANY producer already has a production flow node
      const anyProducerHasFlowNode = producers.some((p) =>
        flowNodes.some((n) => n.id === p.recipeId),
      );

      const userTargetRate =
        targetRates?.get(node.itemId) ?? node.productionRate;

      // Only embed recipe info in the sink when there's exactly one producer
      // without a separate flow node (terminal target with single recipe)
      const soleProducer =
        producers.length === 1
          ? (plan.nodes.get(producers[0].recipeId) as
              | Extract<ProductionGraphNode, { type: "recipe" }>
              | undefined)
          : undefined;
      const shouldEmbedRecipeInfo = soleProducer && !anyProducerHasFlowNode;

      targetSinkNodes.push(
        createTargetSinkNode(
          targetNodeId,
          node.item,
          userTargetRate,
          items,
          facilities,
          shouldEmbedRecipeInfo
            ? {
                facility: soleProducer.facility,
                facilityCount: soleProducer.facilityCount,
                recipe: soleProducer.recipe,
              }
            : undefined,
          ceilMode,
        ),
      );

      // Edge from producer recipe(s) to target sink:
      // - Always for non-terminal targets
      // - Also for terminal targets when the recipe already has a production node
      //   (byproduct scenario: recipe serves a primary output elsewhere)
      if (producers.length > 0 && (!isTerminalTarget || anyProducerHasFlowNode)) {
        const totalProduction = producers.reduce((sum, p) => sum + p.rate, 0);

        for (const producer of producers) {
          const edgeRate =
            totalProduction > 0
              ? userTargetRate * (producer.rate / totalProduction)
              : userTargetRate / producers.length;

          const producerNode = plan.nodes.get(producer.recipeId);
          let edgeFacilityCount: number | undefined;
          if (producerNode?.type === "recipe") {
            const outputEntry = producerNode.recipe.outputs.find(
              (o) => o.itemId === node.itemId,
            );
            if (outputEntry) {
              const ratePerFacility = calcRate(
                outputEntry.amount,
                producerNode.recipe.craftingTime,
              );
              edgeFacilityCount = Math.ceil(edgeRate / ratePerFacility);
            }
          }
          flowEdges.push(
            createEdge(
              `e${edgeIdCounter++}`,
              producer.recipeId,
              targetNodeId,
              edgeRate,
              node.item,
              undefined,
              ceilMode,
              edgeFacilityCount,
            ),
          );
        }
      }
    }
  });

  // Create disposal sink nodes for disposal recipes
  const disposalSinkNodes: FlowDisposalNode[] = [];
  plan.nodes.forEach((node, nodeId) => {
    if (node.type !== "recipe" || !node.isDisposal) return;

    const disposalSinkId = `disposal-${nodeId}`;

    // Find the consumed item (edge: item -> disposal recipe)
    const consumedItemId = getRecipeInputItemId(plan, nodeId);
    if (!consumedItemId) return;

    const consumedItemNode = plan.nodes.get(consumedItemId);
    if (!consumedItemNode || consumedItemNode.type !== "item") return;

    const disposalRate =
      calcRate(
        node.recipe.inputs[0].amount,
        node.recipe.craftingTime,
      ) * node.facilityCount;

    disposalSinkNodes.push(
      createDisposalSinkNode(
        disposalSinkId,
        consumedItemNode.item,
        disposalRate,
        node.facility,
        node.facilityCount,
        items,
        facilities,
        ceilMode,
      ),
    );

    // Find ALL producer recipes of the consumed item and create edges from each
    const producers = getItemProducers(plan, consumedItemId);
    const totalProduction = producers.reduce((sum, p) => sum + p.rate, 0);

    for (const producer of producers) {
      const edgeRate =
        totalProduction > 0
          ? disposalRate * (producer.rate / totalProduction)
          : disposalRate;

      // Compute how many facilities of this producer contribute
      const producerNode = plan.nodes.get(producer.recipeId);
      let edgeFacilityCount: number | undefined;
      if (producerNode?.type === "recipe") {
        const outputEntry = producerNode.recipe.outputs.find(
          (o) => o.itemId === consumedItemNode.itemId,
        );
        if (outputEntry) {
          const ratePerFacility = calcRate(
            outputEntry.amount,
            producerNode.recipe.craftingTime,
          );
          edgeFacilityCount = Math.ceil(edgeRate / ratePerFacility);
        }
      }
      flowEdges.push(
        createEdge(
          `e${edgeIdCounter++}`,
          producer.recipeId,
          disposalSinkId,
          edgeRate,
          consumedItemNode.item,
          undefined,
          ceilMode,
          edgeFacilityCount,
        ),
      );
    }
  });

  return {
    nodes: [...flowNodes, ...targetSinkNodes, ...disposalSinkNodes] as (
      | FlowProductionNode
      | FlowTargetNode
      | FlowDisposalNode
    )[],
    edges: flowEdges,
  };
}
