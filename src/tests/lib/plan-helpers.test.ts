import { describe, test, expect } from "vitest";
import { computeGreedyAllocation } from "@/lib/plan-helpers";

describe("computeGreedyAllocation", () => {
  test("single producer, single consumer — direct assignment", () => {
    const result = computeGreedyAllocation(
      [{ recipeId: "A", rate: 60 }],
      [{ consumerId: "C1", demand: 60 }],
    );

    expect(result.consumerEdges).toEqual([
      { producerRecipeId: "A", consumerId: "C1", rate: 60 },
    ]);
    expect(result.remainingByProducer.get("A")).toBeCloseTo(0);
  });

  test("single producer, demand less than production — surplus remains", () => {
    const result = computeGreedyAllocation(
      [{ recipeId: "A", rate: 60 }],
      [{ consumerId: "C1", demand: 30 }],
    );

    expect(result.consumerEdges).toEqual([
      { producerRecipeId: "A", consumerId: "C1", rate: 30 },
    ]);
    expect(result.remainingByProducer.get("A")).toBeCloseTo(30);
  });

  test("multi-producer, single consumer — largest fills first", () => {
    // Furnace (60) + Crucible (30) → SCC consumer (60)
    // Furnace alone satisfies demand. Crucible is surplus.
    const result = computeGreedyAllocation(
      [
        { recipeId: "furnace", rate: 60 },
        { recipeId: "crucible", rate: 30 },
      ],
      [{ consumerId: "scc", demand: 60 }],
    );

    expect(result.consumerEdges).toEqual([
      { producerRecipeId: "furnace", consumerId: "scc", rate: 60 },
    ]);
    expect(result.remainingByProducer.get("furnace")).toBeCloseTo(0);
    expect(result.remainingByProducer.get("crucible")).toBeCloseTo(30);
  });

  test("multi-producer, single consumer — demand exceeds largest producer", () => {
    // Producer A (40) + Producer B (30) → Consumer (60)
    // A fills 40, B fills remaining 20. B has 10 surplus.
    const result = computeGreedyAllocation(
      [
        { recipeId: "A", rate: 40 },
        { recipeId: "B", rate: 30 },
      ],
      [{ consumerId: "C1", demand: 60 }],
    );

    expect(result.consumerEdges).toEqual([
      { producerRecipeId: "A", consumerId: "C1", rate: 40 },
      { producerRecipeId: "B", consumerId: "C1", rate: 20 },
    ]);
    expect(result.remainingByProducer.get("A")).toBeCloseTo(0);
    expect(result.remainingByProducer.get("B")).toBeCloseTo(10);
  });

  test("multi-producer, multiple consumers — greedy minimizes edges", () => {
    // Producers: A (30), B (30)
    // Consumers: C1 (30), C2 (20)
    // Greedy: A fills C1 entirely, B fills C2 with 10 surplus.
    const result = computeGreedyAllocation(
      [
        { recipeId: "A", rate: 30 },
        { recipeId: "B", rate: 30 },
      ],
      [
        { consumerId: "C1", demand: 30 },
        { consumerId: "C2", demand: 20 },
      ],
    );

    // A (or B, both equal rate) fills C1 entirely
    expect(result.consumerEdges).toHaveLength(2);

    // Each consumer gets exactly one edge (one producer each)
    const c1Edges = result.consumerEdges.filter(
      (e) => e.consumerId === "C1",
    );
    const c2Edges = result.consumerEdges.filter(
      (e) => e.consumerId === "C2",
    );
    expect(c1Edges).toHaveLength(1);
    expect(c1Edges[0].rate).toBeCloseTo(30);
    expect(c2Edges).toHaveLength(1);
    expect(c2Edges[0].rate).toBeCloseTo(20);

    // 10 surplus from the second producer
    const totalRemaining = Array.from(
      result.remainingByProducer.values(),
    ).reduce((sum, v) => sum + v, 0);
    expect(totalRemaining).toBeCloseTo(10);
  });

  test("demand exceeds total production — allocates what's available", () => {
    const result = computeGreedyAllocation(
      [{ recipeId: "A", rate: 30 }],
      [{ consumerId: "C1", demand: 60 }],
    );

    expect(result.consumerEdges).toEqual([
      { producerRecipeId: "A", consumerId: "C1", rate: 30 },
    ]);
    expect(result.remainingByProducer.get("A")).toBeCloseTo(0);
  });

  test("no consumers — all production remains for disposal", () => {
    const result = computeGreedyAllocation(
      [
        { recipeId: "A", rate: 60 },
        { recipeId: "B", rate: 30 },
      ],
      [],
    );

    expect(result.consumerEdges).toHaveLength(0);
    expect(result.remainingByProducer.get("A")).toBeCloseTo(60);
    expect(result.remainingByProducer.get("B")).toBeCloseTo(30);
  });

  test("producers are sorted by rate regardless of input order", () => {
    // Input order: small first. Should still assign large producer first.
    const result = computeGreedyAllocation(
      [
        { recipeId: "small", rate: 10 },
        { recipeId: "large", rate: 50 },
      ],
      [{ consumerId: "C1", demand: 50 }],
    );

    expect(result.consumerEdges).toEqual([
      { producerRecipeId: "large", consumerId: "C1", rate: 50 },
    ]);
    expect(result.remainingByProducer.get("large")).toBeCloseTo(0);
    expect(result.remainingByProducer.get("small")).toBeCloseTo(10);
  });
});
