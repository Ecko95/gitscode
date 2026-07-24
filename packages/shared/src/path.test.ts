import { describe, expect, it } from "vitest";
import {
  isPathWithin,
  isExplicitRelativePath,
  isUncPath,
  normalizePath,
  isWindowsAbsolutePath,
  isWindowsDrivePath,
} from "./path.ts";

describe("path helpers", () => {
  it("detects windows drive paths", () => {
    expect(isWindowsDrivePath("C:\\repo")).toBe(true);
    expect(isWindowsDrivePath("D:/repo")).toBe(true);
    expect(isWindowsDrivePath("/repo")).toBe(false);
  });

  it("detects UNC paths", () => {
    expect(isUncPath("\\\\server\\share\\repo")).toBe(true);
    expect(isUncPath("C:\\repo")).toBe(false);
  });

  it("detects windows absolute paths", () => {
    expect(isWindowsAbsolutePath("C:\\repo")).toBe(true);
    expect(isWindowsAbsolutePath("\\\\server\\share\\repo")).toBe(true);
    expect(isWindowsAbsolutePath("./repo")).toBe(false);
  });

  it("detects explicit relative paths", () => {
    expect(isExplicitRelativePath(".")).toBe(true);
    expect(isExplicitRelativePath("..")).toBe(true);
    expect(isExplicitRelativePath("./repo")).toBe(true);
    expect(isExplicitRelativePath("..\\repo")).toBe(true);
    expect(isExplicitRelativePath("~/repo")).toBe(false);
  });

  it("normalizes separators and Windows path casing", () => {
    expect(normalizePath("C:\\Work\\repo\\")).toBe("c:/work/repo");
    expect(normalizePath("/work//repo/")).toBe("/work/repo");
  });

  it("checks path containment at segment boundaries", () => {
    expect(isPathWithin("/work/repo", "/work")).toBe(true);
    expect(isPathWithin("/workshop/repo", "/work")).toBe(false);
    expect(isPathWithin("/work/repo", "")).toBe(false);
  });
});
