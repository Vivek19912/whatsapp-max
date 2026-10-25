import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  handleExpiredSession,
  handleExpiredSessionResponse,
  isAuthPagePath,
  isExpiredSessionStatus,
  resetExpiredSessionForTests,
} from "./expired-session";

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe("isExpiredSessionStatus", () => {
  it("matches only 401", () => {
    expect(isExpiredSessionStatus(401)).toBe(true);
    expect(isExpiredSessionStatus(403)).toBe(false);
    expect(isExpiredSessionStatus(400)).toBe(false);
    expect(isExpiredSessionStatus(422)).toBe(false);
    expect(isExpiredSessionStatus(500)).toBe(false);
    expect(isExpiredSessionStatus(200)).toBe(false);
  });
});

describe("isAuthPagePath", () => {
  it("detects auth pages where a redirect would loop", () => {
    expect(isAuthPagePath("/login")).toBe(true);
    expect(isAuthPagePath("/signup")).toBe(true);
    expect(isAuthPagePath("/forgot-password")).toBe(true);
    expect(isAuthPagePath("/reset-password")).toBe(true);
    expect(isAuthPagePath("/join/abc")).toBe(true);
    expect(isAuthPagePath("/workspace")).toBe(false);
    expect(isAuthPagePath("/dashboard")).toBe(false);
  });
});

describe("handleExpiredSessionResponse", () => {
  beforeEach(() => {
    resetExpiredSessionForTests();
  });

  it("401 clears the dead session and redirects to the existing sign-in page", async () => {
    const signOut = vi.fn(async () => undefined);
    const redirect = vi.fn();
    const handled = handleExpiredSessionResponse(
      { status: 401 },
      { signOut, getPathname: () => "/workspace", redirect },
    );
    expect(handled).toBe(true);
    await flush();
    expect(signOut).toHaveBeenCalledTimes(1);
    expect(redirect).toHaveBeenCalledTimes(1);
  });

  it("simultaneous 401s trigger exactly one sign-out + redirect", async () => {
    const signOut = vi.fn(async () => undefined);
    const redirect = vi.fn();
    const deps = {
      signOut,
      getPathname: () => "/workspace",
      redirect,
    };
    // Three parallel API fetches all fail with 401 at once.
    const results = [
      handleExpiredSessionResponse({ status: 401 }, deps),
      handleExpiredSessionResponse({ status: 401 }, deps),
      handleExpiredSessionResponse({ status: 401 }, deps),
    ];
    expect(results).toEqual([true, true, true]);
    await flush();
    expect(signOut).toHaveBeenCalledTimes(1);
    expect(redirect).toHaveBeenCalledTimes(1);
  });

  it("allows a fresh sign-in cycle afterward (reset re-arms the handler)", async () => {
    const firstSignOut = vi.fn(async () => undefined);
    const firstRedirect = vi.fn();
    handleExpiredSessionResponse(
      { status: 401 },
      {
        signOut: firstSignOut,
        getPathname: () => "/workspace",
        redirect: firstRedirect,
      },
    );
    await flush();
    expect(firstSignOut).toHaveBeenCalledTimes(1);

    // Simulate the post-login state: user signs in again successfully,
    // then the session expires much later — the handler must fire again.
    resetExpiredSessionForTests();
    const secondSignOut = vi.fn(async () => undefined);
    const secondRedirect = vi.fn();
    const handled = handleExpiredSessionResponse(
      { status: 401 },
      {
        signOut: secondSignOut,
        getPathname: () => "/workspace",
        redirect: secondRedirect,
      },
    );
    expect(handled).toBe(true);
    await flush();
    expect(secondSignOut).toHaveBeenCalledTimes(1);
    expect(secondRedirect).toHaveBeenCalledTimes(1);
  });

  it("403 never triggers logout or redirect", async () => {
    const signOut = vi.fn(async () => undefined);
    const redirect = vi.fn();
    const handled = handleExpiredSessionResponse(
      { status: 403 },
      { signOut, getPathname: () => "/workspace", redirect },
    );
    expect(handled).toBe(false);
    await flush();
    expect(signOut).not.toHaveBeenCalled();
    expect(redirect).not.toHaveBeenCalled();
  });

  it("validation and server errors never trigger logout or redirect", async () => {
    for (const status of [400, 422, 404, 500, 503]) {
      resetExpiredSessionForTests();
      const signOut = vi.fn(async () => undefined);
      const redirect = vi.fn();
      const handled = handleExpiredSessionResponse(
        { status },
        { signOut, getPathname: () => "/workspace", redirect },
      );
      expect(handled).toBe(false);
      await flush();
      expect(signOut).not.toHaveBeenCalled();
      expect(redirect).not.toHaveBeenCalled();
    }
  });

  it("does not redirect when already on the sign-in page (no loop), but still clears state", async () => {
    const signOut = vi.fn(async () => undefined);
    const redirect = vi.fn();
    const handled = handleExpiredSession(
      // Already signed out / on the login page.
      { signOut, getPathname: () => "/login", redirect },
    );
    expect(handled).toBe(true);
    await flush();
    expect(signOut).toHaveBeenCalledTimes(1);
    expect(redirect).not.toHaveBeenCalled();
  });

  it("never throws, even when sign-out fails", async () => {
    const signOut = vi.fn(async () => {
      throw new Error("storage blew up");
    });
    const redirect = vi.fn();
    expect(() =>
      handleExpiredSessionResponse(
        { status: 401 },
        { signOut, getPathname: () => "/workspace", redirect },
      ),
    ).not.toThrow();
    await flush();
    // Still lands on /login where the shell + middleware finish the job.
    expect(redirect).toHaveBeenCalledTimes(1);
  });
});
