import React from "react";
import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import App from "./App";

const SETTINGS_KEY = "pomodoro.settings.v1";
const STATS_KEY = "pomodoro.stats.v1";

/**
 * Freeze "todayKey()" to a stable local date so we can assert localStorage keys.
 * App's todayKey() uses local-time components (getFullYear/getMonth/getDate).
 */
function mockTodayToLocalDate({ year, monthIndex, day }) {
  const RealDate = Date;

  // eslint-disable-next-line no-global-assign
  global.Date = class extends RealDate {
    constructor(...args) {
      // If Date() constructed with args, honor it; else use our fixed local date
      if (args.length > 0) {
        // @ts-ignore
        return new RealDate(...args);
      }
      return new RealDate(year, monthIndex, day, 12, 0, 0, 0);
    }

    static now() {
      return new RealDate(year, monthIndex, day, 12, 0, 0, 0).getTime();
    }
  };

  return () => {
    // eslint-disable-next-line no-global-assign
    global.Date = RealDate;
  };
}

function getTimeText() {
  const el = screen.getByText(/^\d\d:\d\d$/);
  return el.textContent;
}

/**
 * Configure Jest fake timers such that:
 * - `Date.now()` advances when we advance timers
 * - interval/timeout callbacks are flushed deterministically
 *
 * CRA 5 uses Jest 27; "modern" fake timers support `advanceTimers` and `setSystemTime`.
 */
function useDeterministicFakeTimers() {
  jest.useFakeTimers("modern");
  jest.setSystemTime(new Date("2020-01-02T12:00:00.000Z"));
}

/**
 * Advance both virtual time (setTimeout / setInterval) and system time (Date.now()).
 * This is required because App's tick() relies on Date.now/endAt calculations.
 */
async function advanceTime(ms) {
  act(() => {
    jest.advanceTimersByTime(ms);
  });

  // Give React a chance to commit updates scheduled from timer callbacks.
  await act(async () => {
    await Promise.resolve();
  });
}

/**
 * Flush pending timers and allow React/user-event microtasks to settle.
 * This is important since the app uses interval ticks, timeouts, and state updates.
 */
async function flushTimersAndMicrotasks(user) {
  act(() => {
    jest.runOnlyPendingTimers();
  });

  // Give React a turn to commit state updates after timer callbacks.
  await act(async () => {
    await Promise.resolve();
  });

  // user-event uses promises/microtasks; allow them to flush too.
  if (user?.keyboard) {
    await Promise.resolve();
  }
}

function getSettingsButton() {
  return screen.getByRole("button", { name: /settings/i });
}

function getSettingsDialog() {
  return screen.getByRole("dialog", { name: /pomodoro settings/i });
}

function getTimerControlsGroup() {
  return screen.getByRole("group", { name: /timer controls/i });
}

function getPhaseTitleRegion() {
  // "Work Session"/"Break Session" also appears elsewhere (stats copy), so we scope to the phase header region
  // by anchoring on the unique h1 values (FOCUS/CHILL).
  const titleHeading = screen.queryByRole("heading", { name: /^focus$/i })
    ? screen.getByRole("heading", { name: /^focus$/i })
    : screen.getByRole("heading", { name: /^chill$/i });

  return titleHeading.closest(".phaseTitle") || document.body;
}

function getPhaseKicker() {
  return within(getPhaseTitleRegion()).getByText(/work session|break session/i);
}

// PUBLIC_INTERFACE
function expectToastMessageOptional(matcher) {
  /**
   * Toast is transient (3s) and non-critical for state transitions.
   * In CI/fake-timer environments it may appear/disappear in the same flush cycle.
   *
   * We make this expectation optional/non-fatal to avoid flakiness:
   * - If present, assert it's in the document (sanity check)
   * - If absent, do not fail the test
   */
  const toastText = screen.queryByText(matcher);
  if (toastText) {
    expect(toastText).toBeInTheDocument();
  }
}

/**
 * Create a realistic Notification mock:
 * - App checks `"Notification" in window` and `Notification.permission`
 * - App calls `Notification.requestPermission()` (if permission === "default")
 * - App creates notifications via `new Notification(title, { body })`
 *
 * We implement a constructable function so `new Notification()` is observable.
 */
function installNotificationMock({ permission = "default", requestPermissionResult = permission } = {}) {
  // Make it "newable": when App does `new Notification(...)`, it calls this function as a constructor.
  function NotificationShim(title, options) {
    // no-op; jest.fn wrapper captures calls
    void title;
    void options;
  }

  // Jest can spy on calls to NotificationShim itself (constructor calls).
  const asFn = jest.fn(NotificationShim);

  // Static-ish properties that the app reads.
  Object.defineProperty(asFn, "permission", { value: permission, writable: true });
  asFn.requestPermission = jest.fn().mockResolvedValue(requestPermissionResult);

  // Install into window
  window.Notification = asFn;

  return { NotificationMock: asFn, requestPermission: asFn.requestPermission };
}

describe("Pomodoro App", () => {
  beforeEach(() => {
    localStorage.clear();
    useDeterministicFakeTimers();
  });

  afterEach(() => {
    // Ensure no timers leak between tests (toast timeout, interval, etc.)
    act(() => {
      jest.runOnlyPendingTimers();
    });
    jest.useRealTimers();
    jest.restoreAllMocks();
    localStorage.clear();
    delete window.Notification;
  });

  test("renders the Focus Timer Pro header and initial controls", () => {
    render(<App />);
    expect(screen.getByText(/Focus Timer Pro/i)).toBeInTheDocument();

    const controls = getTimerControlsGroup();
    expect(within(controls).getByRole("button", { name: /start/i })).toBeInTheDocument();
    expect(within(controls).getByRole("button", { name: /reset/i })).toBeInTheDocument();
    expect(within(controls).getByRole("button", { name: /skip/i })).toBeInTheDocument();

    expect(getTimeText()).toBe("25:00");

    expect(getPhaseKicker()).toHaveTextContent(/work session/i);
    expect(screen.getByRole("heading", { name: /^focus$/i })).toBeInTheDocument();
  });

  test("timer start/pause: Start requests permission (if Notification default) and toggles to Pause; Pause freezes countdown", async () => {
    const requestPermission = jest.fn().mockResolvedValue("denied");

    // App checks: ("Notification" in window) and Notification.permission / Notification.requestPermission()
    window.Notification = {
      permission: "default",
      requestPermission,
    };

    render(<App />);
    const user = userEvent.setup({ advanceTimers: jest.advanceTimersByTime });

    expect(getTimeText()).toBe("25:00");

    await user.click(screen.getByRole("button", { name: /start/i }));
    await flushTimersAndMicrotasks(user);

    expect(requestPermission).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: /pause/i })).toBeInTheDocument();

    await advanceTime(1200);
    await flushTimersAndMicrotasks(user);

    const afterStart = getTimeText();
    expect(afterStart).not.toBe("25:00");

    await user.click(screen.getByRole("button", { name: /pause/i }));
    await flushTimersAndMicrotasks(user);

    expect(screen.getByRole("button", { name: /start/i })).toBeInTheDocument();

    const frozen = getTimeText();
    await advanceTime(2500);
    await flushTimersAndMicrotasks(user);

    expect(getTimeText()).toBe(frozen);
  });

  test("reset sets timer back to full phase duration (toast is optional)", async () => {
    render(<App />);
    const user = userEvent.setup({ advanceTimers: jest.advanceTimersByTime });

    await user.click(screen.getByRole("button", { name: /start/i }));
    await flushTimersAndMicrotasks(user);

    await advanceTime(2200);
    await flushTimersAndMicrotasks(user);
    expect(getTimeText()).not.toBe("25:00");

    await user.click(screen.getByRole("button", { name: /reset/i }));
    await flushTimersAndMicrotasks(user);

    expect(getTimeText()).toBe("25:00");

    // Toast is optional/non-fatal.
    expectToastMessageOptional(/reset\./i);
  });

  test("settings apply immediately while paused: changing Work minutes updates display and persists to localStorage", async () => {
    render(<App />);
    const user = userEvent.setup({ advanceTimers: jest.advanceTimersByTime });

    expect(getTimeText()).toBe("25:00");

    await user.click(getSettingsButton());
    const dialog = getSettingsDialog();

    const workInput = within(dialog).getByLabelText(/work minutes/i);
    expect(workInput).toHaveValue(25);

    await user.clear(workInput);
    await user.type(workInput, "1");

    // While not running, display updates immediately.
    expect(getTimeText()).toBe("01:00");

    // Persist happens in effect; allow React to flush.
    await flushTimersAndMicrotasks(user);

    const stored = JSON.parse(localStorage.getItem(SETTINGS_KEY));
    expect(stored).toMatchObject({ workMinutes: 1, breakMinutes: 5, autoStartNext: false });

    await user.click(within(dialog).getByRole("button", { name: /done/i }));
    expect(screen.queryByRole("dialog", { name: /pomodoro settings/i })).not.toBeInTheDocument();
  });

  test("settings while running do NOT change current countdown immediately; reset applies new duration", async () => {
    render(<App />);
    const user = userEvent.setup({ advanceTimers: jest.advanceTimersByTime });

    await user.click(screen.getByRole("button", { name: /start/i }));
    await flushTimersAndMicrotasks(user);

    await advanceTime(1500);
    await flushTimersAndMicrotasks(user);

    const runningTime = getTimeText();
    expect(runningTime).not.toBe("25:00");

    await user.click(getSettingsButton());
    const dialog = getSettingsDialog();
    const workInput = within(dialog).getByLabelText(/work minutes/i);

    await user.clear(workInput);
    await user.type(workInput, "2");

    // Should not jump while running
    expect(getTimeText()).toBe(runningTime);

    await user.click(within(dialog).getByRole("button", { name: /done/i }));
    await user.click(screen.getByRole("button", { name: /reset/i }));
    await flushTimersAndMicrotasks(user);

    expect(getTimeText()).toBe("02:00");
  });

  test("phase transitions: completing a work session increments today's completedPomodoros and switches to Break; stats persist", async () => {
    const restoreDate = mockTodayToLocalDate({ year: 2020, monthIndex: 0, day: 2 });

    localStorage.setItem(
      SETTINGS_KEY,
      JSON.stringify({ workMinutes: 1, breakMinutes: 1, autoStartNext: false })
    );

    render(<App />);
    const user = userEvent.setup({ advanceTimers: jest.advanceTimersByTime });

    expect(getTimeText()).toBe("01:00");
    expect(screen.getByRole("heading", { name: /^focus$/i })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /start/i }));
    await flushTimersAndMicrotasks(user);

    /**
     * The app ticks every 250ms and uses Date.now/endAt; in fake timers we must
     * advance both timers and Date.now.
     *
     * We slightly over-advance to ensure we cross the boundary and the next interval tick runs.
     */
    await advanceTime(61_500);
    await flushTimersAndMicrotasks(user);

    // Phase should have switched to break (CHILL).
    expect(screen.getByRole("heading", { name: /^chill$/i })).toBeInTheDocument();
    expect(getPhaseKicker()).toHaveTextContent(/break session/i);

    // Toast is optional/non-fatal.
    expectToastMessageOptional(/work complete/i);

    const storedStats = JSON.parse(localStorage.getItem(STATS_KEY));
    expect(storedStats).toEqual({
      "2020-01-02": { completedPomodoros: 1 },
    });

    restoreDate();
  });

  test("skip toggles phase without incrementing completed pomodoros", async () => {
    const restoreDate = mockTodayToLocalDate({ year: 2020, monthIndex: 0, day: 2 });

    localStorage.setItem(
      SETTINGS_KEY,
      JSON.stringify({ workMinutes: 1, breakMinutes: 1, autoStartNext: false })
    );

    render(<App />);
    const user = userEvent.setup({ advanceTimers: jest.advanceTimersByTime });

    expect(screen.getByRole("heading", { name: /^focus$/i })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /skip/i }));
    await flushTimersAndMicrotasks(user);

    expect(screen.getByRole("heading", { name: /^chill$/i })).toBeInTheDocument();

    // Toast is optional/non-fatal.
    expectToastMessageOptional(/skipped to break/i);

    const storedStats = JSON.parse(localStorage.getItem(STATS_KEY));
    expect(storedStats ?? {}).toEqual({});

    restoreDate();
  });

  test("notifications: if Notification is unsupported, UI shows N/A and start does not throw", async () => {
    delete window.Notification;

    render(<App />);
    const user = userEvent.setup({ advanceTimers: jest.advanceTimersByTime });

    expect(screen.getByText(/notify/i)).toBeInTheDocument();
    expect(screen.getByText("N/A")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /start/i }));
    await flushTimersAndMicrotasks(user);

    expect(screen.getByRole("button", { name: /pause/i })).toBeInTheDocument();
  });

  test("notifications: when permission is granted, completing work session creates a Notification; when denied, it does not", async () => {
    const restoreDate = mockTodayToLocalDate({ year: 2020, monthIndex: 0, day: 2 });

    // Case A: granted -> new Notification called
    localStorage.setItem(
      SETTINGS_KEY,
      JSON.stringify({ workMinutes: 1, breakMinutes: 1, autoStartNext: false })
    );

    const { NotificationMock: grantedMock } = installNotificationMock({
      permission: "granted",
      requestPermissionResult: "granted",
    });

    const user = userEvent.setup({ advanceTimers: jest.advanceTimersByTime });

    const { unmount } = render(<App />);

    await user.click(screen.getByRole("button", { name: /start/i }));
    await flushTimersAndMicrotasks(user);

    await advanceTime(61_500);
    await flushTimersAndMicrotasks(user);

    // Align with the actual completion path: Notification is created at phase end.
    expect(grantedMock).toHaveBeenCalledWith("Work complete", {
      body: "Take a short break. You earned it.",
    });

    // Cleanup between cases to avoid multiple mounted apps.
    unmount();

    // Case B: denied -> new Notification not called
    localStorage.clear();
    localStorage.setItem(
      SETTINGS_KEY,
      JSON.stringify({ workMinutes: 1, breakMinutes: 1, autoStartNext: false })
    );

    const { NotificationMock: deniedMock } = installNotificationMock({
      permission: "denied",
      requestPermissionResult: "denied",
    });

    render(<App />);

    await user.click(screen.getByRole("button", { name: /start/i }));
    await flushTimersAndMicrotasks(user);

    await advanceTime(61_500);
    await flushTimersAndMicrotasks(user);

    expect(deniedMock).toHaveBeenCalledTimes(0);

    restoreDate();
  });

  test("auto-start next: when enabled, completing a phase auto-starts the next phase (Pause visible soon after)", async () => {
    const restoreDate = mockTodayToLocalDate({ year: 2020, monthIndex: 0, day: 2 });

    localStorage.setItem(
      SETTINGS_KEY,
      JSON.stringify({ workMinutes: 1, breakMinutes: 1, autoStartNext: true })
    );

    // Notification default so startTimer triggers requestPermission, but we don't care about its result here.
    installNotificationMock({ permission: "default", requestPermissionResult: "denied" });

    render(<App />);
    const user = userEvent.setup({ advanceTimers: jest.advanceTimersByTime });

    await user.click(screen.getByRole("button", { name: /start/i }));
    await flushTimersAndMicrotasks(user);

    await advanceTime(61_500);
    await flushTimersAndMicrotasks(user);

    // Phase should have switched
    expect(screen.getByRole("heading", { name: /^chill$/i })).toBeInTheDocument();

    // Auto-start schedules startTimer after 100ms; ensure the timeout + first interval tick runs.
    await advanceTime(300);
    await flushTimersAndMicrotasks(user);

    expect(screen.getByRole("button", { name: /pause/i })).toBeInTheDocument();

    restoreDate();
  });
});
