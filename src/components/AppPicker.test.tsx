/**
 * AppPicker — "all apps, or pick some". `null` = all (new apps included), a list = a pick.
 */
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AppPicker, summarize, type AppPickerItem } from "./AppPicker";

const ITEMS: AppPickerItem[] = [
  { id: "Appdemo2", label: "Appdemo2", sublabel: "/Applications/Appdemo2.app", count: 2 },
  { id: "Docker", label: "Docker" },
  { id: "Xcode", label: "Xcode" },
];
afterEach(cleanup);

function setup(selected: string[] | null) {
  const onChange = vi.fn();
  render(<AppPicker items={ITEMS} selected={selected} onChange={onChange} label="Filter apps" />);
  fireEvent.click(screen.getByRole("button", { name: "Filter apps" }));
  return onChange;
}
const row = (name: string) =>
  screen.getAllByRole("option").find((o) => o.textContent?.includes(name))!;

describe("summarize", () => {
  it.each([
    [null, "All apps"],
    [[], "No apps"],
    [["Docker"], "Docker"],
    [["gone"], "gone"],
    [["Docker", "Xcode"], "2 apps"],
  ] as const)("%j → %s", (sel, want) => {
    expect(summarize(sel as string[] | null, ITEMS, "apps")).toBe(want);
  });
});

describe("AppPicker", () => {
  it("is closed until clicked, and names the choice on the trigger", () => {
    render(<AppPicker items={ITEMS} selected={["Xcode"]} onChange={() => {}} label="Filter apps" />);
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(screen.getByRole("button", { name: "Filter apps" })).toHaveTextContent("Xcode ▾");
  });

  it("unticking one app under All turns ALL into an explicit pick of the rest", () => {
    const onChange = setup(null);
    fireEvent.click(within(row("Docker")).getByRole("checkbox"));
    expect(onChange).toHaveBeenCalledWith(["Appdemo2", "Xcode"]);
  });

  it("ticking an app adds it to a pick, and unticking removes it", () => {
    const onChange = setup(["Docker"]);
    fireEvent.click(within(row("Xcode")).getByRole("checkbox"));
    expect(onChange).toHaveBeenLastCalledWith(["Docker", "Xcode"]);
    fireEvent.click(within(row("Docker")).getByRole("checkbox"));
    expect(onChange).toHaveBeenLastCalledWith([]);
  });

  it("the All row toggles between null (all) and [] (none)", () => {
    const a = setup(["Docker"]);
    fireEvent.click(within(row("All apps")).getByRole("checkbox"));
    expect(a).toHaveBeenCalledWith(null);
    cleanup();
    const b = setup(null);
    fireEvent.click(within(row("All apps")).getByRole("checkbox"));
    expect(b).toHaveBeenCalledWith([]);
  });

  it("Only picks exactly that app", () => {
    const onChange = setup(null);
    fireEvent.click(within(row("Appdemo2")).getByRole("button", { name: "Only" }));
    expect(onChange).toHaveBeenCalledWith(["Appdemo2"]);
  });

  it("search narrows rows by label or sublabel, and says when nothing matches", () => {
    setup(null);
    const search = screen.getByRole("textbox", { name: "Search apps" });
    fireEvent.change(search, { target: { value: "applications" } });
    expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual([
      "All apps",
      expect.stringContaining("Appdemo2"),
    ]);
    fireEvent.change(search, { target: { value: "zzz" } });
    expect(screen.getByText("No apps match “zzz”")).toBeInTheDocument();
  });

  it("Escape and an outside click close it; an inside click does not", () => {
    setup(null);
    fireEvent.mouseDown(screen.getByRole("textbox", { name: "Search apps" }));
    expect(screen.getByRole("listbox")).toBeInTheDocument();
    fireEvent.keyDown(window, { key: "a" });
    expect(screen.getByRole("listbox")).toBeInTheDocument();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("listbox")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Filter apps" }));
    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("onOpen fires when the popover opens, not when it closes", () => {
    const onOpen = vi.fn();
    render(<AppPicker items={ITEMS} selected={null} onChange={() => {}} label="Filter apps" onOpen={onOpen} />);
    const t = screen.getByRole("button", { name: "Filter apps" });
    fireEvent.click(t);
    expect(onOpen).toHaveBeenCalledTimes(1);
    fireEvent.click(t);
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it("a row's accessible name separates the label from its sublabel", () => {
    setup(null);
    expect(screen.getByRole("checkbox", { name: "Appdemo2 — /Applications/Appdemo2.app" })).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "Docker" })).toBeInTheDocument();
  });

  it("disabled says why", () => {
    render(<AppPicker items={ITEMS} selected={null} onChange={() => {}} label="Filter apps" disabled disabledReason="Not on Windows yet" />);
    const t = screen.getByRole("button", { name: "Filter apps" });
    expect(t).toBeDisabled();
    expect(t).toHaveAttribute("title", "Not on Windows yet");
  });
});
