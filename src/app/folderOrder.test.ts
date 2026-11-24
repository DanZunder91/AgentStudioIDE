import { describe, expect, it } from "vitest";

import { appendMissing, moveBefore, orderFolders } from "./folderOrder";

describe("orderFolders — the shared folder ordering", () => {
  it("sorts paths by their index in the order list", () => {
    expect(orderFolders(["/a", "/b", "/c"], ["/c", "/a", "/b"])).toEqual([
      "/c",
      "/a",
      "/b",
    ]);
  });

  it("keeps a path NOT in the order after the ordered ones, in input order (stable)", () => {
    // /a is ranked; /x and /y are unranked → they follow, keeping input order.
    expect(orderFolders(["/x", "/a", "/y"], ["/a"])).toEqual(["/a", "/x", "/y"]);
  });

  it("returns input order when the order list is empty", () => {
    expect(orderFolders(["/x", "/y", "/z"], [])).toEqual(["/x", "/y", "/z"]);
  });

  it("ignores order entries that are not among the paths", () => {
    expect(orderFolders(["/a", "/b"], ["/gone", "/b", "/a"])).toEqual(["/b", "/a"]);
  });

  it("does not mutate its input array", () => {
    const paths = ["/a", "/b"];
    orderFolders(paths, ["/b", "/a"]);
    expect(paths).toEqual(["/a", "/b"]);
  });
});

describe("moveBefore — the list-reorder a drag reduces to", () => {
  it("moves an item to sit immediately before the target", () => {
    expect(moveBefore(["a", "b", "c"], "a", "c")).toEqual(["b", "a", "c"]);
  });

  it("moves an item to the end when target is null", () => {
    expect(moveBefore(["a", "b", "c"], "a", null)).toEqual(["b", "c", "a"]);
  });

  it("moves a later item earlier (drag up)", () => {
    expect(moveBefore(["a", "b", "c"], "c", "a")).toEqual(["c", "a", "b"]);
  });

  it("is a no-op-shaped move when dropped before itself (goes to end)", () => {
    // target === item → treated as 'to end' (there is no 'before myself').
    expect(moveBefore(["a", "b", "c"], "b", "b")).toEqual(["a", "c", "b"]);
  });

  it("appends an item absent from the list (a drag can seed a new path)", () => {
    expect(moveBefore(["a", "b"], "z", "a")).toEqual(["z", "a", "b"]);
  });

  it("appends when the target is absent from the list", () => {
    expect(moveBefore(["a", "b"], "a", "gone")).toEqual(["b", "a"]);
  });

  it("does not mutate its input array", () => {
    const list = ["a", "b", "c"];
    moveBefore(list, "a", "c");
    expect(list).toEqual(["a", "b", "c"]);
  });
});

describe("appendMissing — keep the order list complete as folders appear", () => {
  it("appends only the paths not already present, preserving their order", () => {
    expect(appendMissing(["/a", "/b"], ["/b", "/c", "/d"])).toEqual([
      "/a",
      "/b",
      "/c",
      "/d",
    ]);
  });

  it("returns the SAME reference when nothing is new (cheap skip)", () => {
    const order = ["/a", "/b"];
    expect(appendMissing(order, ["/a", "/b"])).toBe(order);
  });

  it("returns the same reference for an empty paths input", () => {
    const order = ["/a"];
    expect(appendMissing(order, [])).toBe(order);
  });

  it("seeds from empty", () => {
    expect(appendMissing([], ["/x", "/y"])).toEqual(["/x", "/y"]);
  });
});
