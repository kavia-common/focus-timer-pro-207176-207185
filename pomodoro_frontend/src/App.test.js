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
  // The "big time" is aria-live=polite. Grab its text content.
  // This is stable in this app and avoids depending on classnames.
  const el = screen.getByText(/^\d\d:\d\d$/);
  return el.textContent;
}

function openSettings() {
  return userEvent.click(screen.getByRole("button", { name: /settings/i }));
}

function getSettingsDialog() {
  return screen.getByRole("dialog", { name: /pomodoro settings/i });
}

function getTimerControlsGroup() {
  return screen.getByRole("group", { name: /timer controls/i });
}

describe("Pomodoro App", () => {
  beforeEach(() => {
    localStorage.clear();
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.runOnlyPendingTimers();
    jest.useRealTimers();
    jest.restoreAllMocks();
    localStorage.clear();
    // ensure any mocked Notification doesn't leak
    delete window.Notification;
  });

  test("renders the Focus Timer Pro header and initial controls", () => {
    render(<App />);
    expect(screen.getByText(/Focus Timer Pro/i)).toBeInTheDocument();

    const controls = getTimerControlsGroup();
    expect(within(controls).getByRole("button", { name: /start/i })).toBeInTheDocument();
    expect(within(controls).getByRole("button", { name: /reset/i })).toBeInTheDocument();
    expect(within(controls).getByRole("button", { name: /skip/i })).toBeInTheDocument();

    // Default initial time for work session: 25:00
    expect(getTimeText()).toBe("25:00");
    expect(screen.getByText(/work session/i)).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /focus/i })).toBeInTheDocument();
  });

  test("timer start/pause: clicking Start requests permission (if Notification default) and toggles to Pause, then Pause stops countdown updates", async () => {
    // Mock Notification API (present but default permission)
    const requestPermission = jest.fn().mockResolvedValue("denied");
    window.Notification = {
      permission: "default",
      requestPermission,
    };

    render(<App />);
    const user = userEvent.setup({ advanceTimers: jest.advanceTimersByTime });

    expect(getTimeText()).toBe("25:00");

    await user.click(screen.getByRole("button", { name: /start/i }));
    expect(requestPermission).toHaveBeenCalledTimes(1);

    // Start button swaps to Pause
    expect(screen.getByRole("button", { name: /pause/i })).toBeInTheDocument();

    // Countdown should decrease after enough time passes
    act(() => {
      jest.advanceTimersByTime(1200);
    });
    const afterStart = getTimeText();
    expect(afterStart).not.toBe("25:00");

    await user.click(screen.getByRole("button", { name: /pause/i }));
    expect(screen.getByRole("button", { name: /start/i })).toBeInTheDocument();

    const frozen = getTimeText();
    act(() => {
      jest.advanceTimersByTime(2500);
    });
    expect(getTimeText()).toBe(frozen);
  });

  test("reset sets timer back to full phase duration and shows toast", async () => {
    render(<App />);
    const user = userEvent.setup({ advanceTimers: jest.advanceTimersByTime });

    await user.click(screen.getByRole("button", { name: /start/i }));
    act(() => {
      jest.advanceTimersByTime(2200);
    });
    expect(getTimeText()).not.toBe("25:00");

    await user.click(screen.getByRole("button", { name: /reset/i }));
    expect(getTimeText()).toBe("25:00");

    // Toast message
    expect(screen.getByRole("status")).toHaveTextContent(/reset\./i);
  });

  test("settings apply immediately while paused: changing Work minutes updates the display and is persisted to localStorage", async () => {
    render(<App />);
    const user = userEvent.setup({ advanceTimers: jest.advanceTimersByTime });

    expect(getTimeText()).toBe("25:00");

    await openSettings();
    const dialog = getSettingsDialog();

    const workInput = within(dialog).getByLabelText(/work minutes/i);
    expect(workInput).toHaveValue(25);

    // Change to 1 minute
    await user.clear(workInput);
    await user.type(workInput, "1");

    // While not running, display updates immediately to 01:00
    expect(getTimeText()).toBe("01:00");

    // Persisted via effect
    const stored = JSON.parse(localStorage.getItem(SETTINGS_KEY));
    expect(stored).toMatchObject({ workMinutes: 1, breakMinutes: 5, autoStartNext: false });

    // Close modal
    await user.click(within(dialog).getByRole("button", { name: /done/i }));
    expect(screen.queryByRole("dialog", { name: /pomodoro settings/i })).not.toBeInTheDocument();
  });

  test("settings while running do NOT change the current countdown immediately; reset applies new duration", async () => {
    render(<App />);
    const user = userEvent.setup({ advanceTimers: jest.advanceTimersByTime });

    // Start timer and let it tick down a bit
    await user.click(screen.getByRole("button", { name: /start/i }));
    act(() => {
      jest.advanceTimersByTime(1500);
    });
    const runningTime = getTimeText();
    expect(runningTime).not.toBe("25:00");

    await openSettings();
    const dialog = getSettingsDialog();
    const workInput = within(dialog).getByLabelText(/work minutes/i);

    // Set to 2 minutes while running
    await user.clear(workInput);
    await user.type(workInput, "2");

    // Countdown continues from current remaining; it should not jump to 02:00 mid-run
    expect(getTimeText()).toBe(runningTime);

    // After reset, timer should be 02:00
    await user.click(within(dialog).getByRole("button", { name: /done/i }));
    await user.click(screen.getByRole("button", { name: /reset/i }));
    expect(getTimeText()).toBe("02:00");
  });

  test("phase transitions: completing a work session increments today's completedPomodoros and switches to Break with toast; stats persist in localStorage", async () => {
    const restoreDate = mockTodayToLocalDate({ year: 2020, monthIndex: 0, day: 2 });

    // Make work session 1 minute so we can complete quickly, break 1 minute for predictable next display
    localStorage.setItem(
      SETTINGS_KEY,
      JSON.stringify({ workMinutes: 1, breakMinutes: 1, autoStartNext: false })
    );

    render(<App />);
    const user = userEvent.setup({ advanceTimers: jest.advanceTimersByTime });

    expect(getTimeText()).toBe("01:00");
    expect(screen.getByRole("heading", { name: /focus/i })).toBeInTheDocument();
    expect(screen.getAllByText("0")[0]).toBeInTheDocument(); // Today stat starts at 0

    await user.click(screen.getByRole("button", { name: /start/i }));

    // Move past end of phase (1 minute). tick is every 250ms and uses Date.now/endAt,
    // so advancing timers is sufficient in fake timers.
    act(() => {
      jest.advanceTimersByTime(61_000);
    });

    // Should be in Break ("CHILL") now
    expect(screen.getByRole("heading", { name: /chill/i })).toBeInTheDocument();
    expect(screen.getByText(/break session/i)).toBeInTheDocument();

    // Toast should announce completion
    const toast = screen.getByRole("status");
    expect(toast).toHaveTextContent(/work complete/i);

    // Daily stats should have incremented (today's completed = 1)
    // There are two "1"s in UI potentially; assert via label card and meta chip:
    expect(screen.getAllByText("1").length).toBeGreaterThanOrEqual(1);

    // Persisted stats should contain key "2020-01-02"
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

    expect(screen.getByRole("heading", { name: /focus/i })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /skip/i }));

    expect(screen.getByRole("heading", { name: /chill/i })).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent(/skipped to break/i);

    // Stats should remain empty (no completed pomodoros on skip)
    const storedStats = JSON.parse(localStorage.getItem(STATS_KEY));
    // App writes stats on mount ({}), so either {} or null depending on timing.
    expect(storedStats ?? {}).toEqual({});

    restoreDate();
  });

  test("notifications: if Notification is unsupported, UI shows N/A and start does not throw", async () => {
    // Ensure Notification is not present
    delete window.Notification;

    render(<App />);
    const user = userEvent.setup({ advanceTimers: jest.advanceTimersByTime });

    // The Notify chip shows N/A
    expect(screen.getByText(/notify/i)).toBeInTheDocument();
    expect(screen.getByText("N/A")).toBeInTheDocument();

    // Start should work without Notification
    await user.click(screen.getByRole("button", { name: /start/i }));
    expect(screen.getByRole("button", { name: /pause/i })).toBeInTheDocument();
  });

  test("notifications: if permission is granted, completing work session attempts to create a Notification; if denied, it does not", async () => {
    const restoreDate = mockTodayToLocalDate({ year: 2020, monthIndex: 0, day: 2 });

    // 1-minute work for quick completion
    localStorage.setItem(
      SETTINGS_KEY,
      JSON.stringify({ workMinutes: 1, breakMinutes: 1, autoStartNext: false })
    );

    // Case A: granted -> new Notification called
    const notificationCtor = jest.fn();
    notificationCtor.permission = "granted";
    notificationCtor.requestPermission = jest.fn().mockResolvedValue("granted");
    window.Notification = notificationCtor;

    render(<App />);
    const user = userEvent.setup({ advanceTimers: jest.advanceTimersByTime });

    await user.click(screen.getByRole("button", { name: /start/i }));

    act(() => {
      jest.advanceTimersByTime(61_000);
    });

    expect(notificationCtor).toHaveBeenCalledTimes(1);
    expect(notificationCtor).toHaveBeenCalledWith("Work complete", {
      body: "Take a short break. You earned it.",
    });

    // Case B: denied -> new Notification not called
    // Re-render fresh with denied
    // Cleanup old tree by rendering again (RTL replaces container)
    const notificationCtorDenied = jest.fn();
    notificationCtorDenied.permission = "denied";
    notificationCtorDenied.requestPermission = jest.fn().mockResolvedValue("denied");
    window.Notification = notificationCtorDenied;

    localStorage.clear();
    localStorage.setItem(
      SETTINGS_KEY,
      JSON.stringify({ workMinutes: 1, breakMinutes: 1, autoStartNext: false })
    );

    render(<App />);
    await user.click(screen.getByRole("button", { name: /start/i }));
    act(() => {
      jest.advanceTimersByTime(61_000);
    });

    expect(notificationCtorDenied).toHaveBeenCalledTimes(0);

    restoreDate();
  });

  test("auto-start next: when enabled, completing a phase automatically starts the next phase (Pause button visible soon after)", async () => {
    const restoreDate = mockTodayToLocalDate({ year: 2020, monthIndex: 0, day: 2 });

    localStorage.setItem(
      SETTINGS_KEY,
      JSON.stringify({ workMinutes: 1, breakMinutes: 1, autoStartNext: true })
    );

    // Notification default but requestPermission resolves (avoid unhandled)
    const requestPermission = jest.fn().mockResolvedValue("denied");
    const notificationCtor = jest.fn();
    notificationCtor.permission = "default";
    notificationCtor.requestPermission = requestPermission;
    window.Notification = notificationCtor;

    render(<App />);
    const user = userEvent.setup({ advanceTimers: jest.advanceTimersByTime });

    await user.click(screen.getByRole("button", { name: /start/i }));

    // Finish work phase
    act(() => {
      jest.advanceTimersByTime(61_000);
    });

    // We should be in break
    expect(screen.getByRole("heading", { name: /chill/i })).toBeInTheDocument();

    // Auto-start schedules startTimer after 100ms
    act(() => {
      jest.advanceTimersByTime(150);
    });

    // Should be running -> Pause shown
    expect(screen.getByRole("button", { name: /pause/i })).toBeInTheDocument();

    restoreDate();
  });
});
