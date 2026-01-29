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

async function flushTimersAndMicrotasks(user) {
  // Run scheduled timers (interval ticks, toast timeout scheduling, auto-start delay)
  act(() => {
    jest.runOnlyPendingTimers();
  });
  // user-event uses promises/microtasks; allow them to flush
  if (user?.keyboard) {
    // noop - just for a stable "await point"
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

function getPhaseKicker() {
  // Avoid ambiguous /work session/i (also appears in stats copy).
  // Use the "phase title" region (kicker + h1).
  return within(screen.getByText(/work session|break session/i).closest(".phaseTitle") || document.body).getByText(
    /work session|break session/i
  );
}

describe("Pomodoro App", () => {
  beforeEach(() => {
    localStorage.clear();
    jest.useFakeTimers();
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

    // Disambiguate "Work Session" from stats copy by scoping to the phase title area.
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

    act(() => {
      jest.advanceTimersByTime(1200);
    });
    await flushTimersAndMicrotasks(user);

    const afterStart = getTimeText();
    expect(afterStart).not.toBe("25:00");

    await user.click(screen.getByRole("button", { name: /pause/i }));
    await flushTimersAndMicrotasks(user);

    expect(screen.getByRole("button", { name: /start/i })).toBeInTheDocument();

    const frozen = getTimeText();
    act(() => {
      jest.advanceTimersByTime(2500);
    });
    await flushTimersAndMicrotasks(user);

    expect(getTimeText()).toBe(frozen);
  });

  test("reset sets timer back to full phase duration and shows toast", async () => {
    render(<App />);
    const user = userEvent.setup({ advanceTimers: jest.advanceTimersByTime });

    await user.click(screen.getByRole("button", { name: /start/i }));
    await flushTimersAndMicrotasks(user);

    act(() => {
      jest.advanceTimersByTime(2200);
    });
    await flushTimersAndMicrotasks(user);
    expect(getTimeText()).not.toBe("25:00");

    await user.click(screen.getByRole("button", { name: /reset/i }));
    await flushTimersAndMicrotasks(user);

    expect(getTimeText()).toBe("25:00");
    expect(screen.getByRole("status")).toHaveTextContent(/reset\./i);
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

    act(() => {
      jest.advanceTimersByTime(1500);
    });
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

  test("phase transitions: completing a work session increments today's completedPomodoros and switches to Break with toast; stats persist", async () => {
    const restoreDate = mockTodayToLocalDate({ year: 2020, monthIndex: 0, day: 2 });

    localStorage.setItem(
      SETTINGS_KEY,
      JSON.stringify({ workMinutes: 1, breakMinutes: 1, autoStartNext: false })
    );

    render(<App />);
    const user = userEvent.setup({ advanceTimers: jest.advanceTimersByTime });

    expect(getTimeText()).toBe("01:00");
    expect(screen.getByRole("heading", { name: /^focus$/i })).toBeInTheDocument();

    // Initial "Today" value is 0, but avoid brittle getAllByText("0") because other 0s may appear.
    expect(screen.getByText(/today/i)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /start/i }));
    await flushTimersAndMicrotasks(user);

    act(() => {
      jest.advanceTimersByTime(61_000);
    });
    await flushTimersAndMicrotasks(user);

    // Should be in break
    expect(screen.getByRole("heading", { name: /^chill$/i })).toBeInTheDocument();
    expect(getPhaseKicker()).toHaveTextContent(/break session/i);

    const toast = screen.getByRole("status");
    expect(toast).toHaveTextContent(/work complete/i);

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
    expect(screen.getByRole("status")).toHaveTextContent(/skipped to break/i);

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

    localStorage.setItem(
      SETTINGS_KEY,
      JSON.stringify({ workMinutes: 1, breakMinutes: 1, autoStartNext: false })
    );

    // Case A: granted -> new Notification called
    const grantedCtor = jest.fn();
    Object.defineProperty(grantedCtor, "permission", { value: "granted", writable: true });
    grantedCtor.requestPermission = jest.fn().mockResolvedValue("granted");
    window.Notification = grantedCtor;

    render(<App />);
    const user = userEvent.setup({ advanceTimers: jest.advanceTimersByTime });

    await user.click(screen.getByRole("button", { name: /start/i }));
    await flushTimersAndMicrotasks(user);

    act(() => {
      jest.advanceTimersByTime(61_000);
    });
    await flushTimersAndMicrotasks(user);

    expect(grantedCtor).toHaveBeenCalledTimes(1);
    expect(grantedCtor).toHaveBeenCalledWith("Work complete", {
      body: "Take a short break. You earned it.",
    });

    // Case B: denied -> new Notification not called
    const deniedCtor = jest.fn();
    Object.defineProperty(deniedCtor, "permission", { value: "denied", writable: true });
    deniedCtor.requestPermission = jest.fn().mockResolvedValue("denied");
    window.Notification = deniedCtor;

    localStorage.clear();
    localStorage.setItem(
      SETTINGS_KEY,
      JSON.stringify({ workMinutes: 1, breakMinutes: 1, autoStartNext: false })
    );

    render(<App />);

    await user.click(screen.getByRole("button", { name: /start/i }));
    await flushTimersAndMicrotasks(user);

    act(() => {
      jest.advanceTimersByTime(61_000);
    });
    await flushTimersAndMicrotasks(user);

    expect(deniedCtor).toHaveBeenCalledTimes(0);

    restoreDate();
  });

  test("auto-start next: when enabled, completing a phase auto-starts the next phase (Pause visible soon after)", async () => {
    const restoreDate = mockTodayToLocalDate({ year: 2020, monthIndex: 0, day: 2 });

    localStorage.setItem(
      SETTINGS_KEY,
      JSON.stringify({ workMinutes: 1, breakMinutes: 1, autoStartNext: true })
    );

    const requestPermission = jest.fn().mockResolvedValue("denied");
    const notificationCtor = jest.fn();
    Object.defineProperty(notificationCtor, "permission", { value: "default", writable: true });
    notificationCtor.requestPermission = requestPermission;
    window.Notification = notificationCtor;

    render(<App />);
    const user = userEvent.setup({ advanceTimers: jest.advanceTimersByTime });

    await user.click(screen.getByRole("button", { name: /start/i }));
    await flushTimersAndMicrotasks(user);

    act(() => {
      jest.advanceTimersByTime(61_000);
    });
    await flushTimersAndMicrotasks(user);

    expect(screen.getByRole("heading", { name: /^chill$/i })).toBeInTheDocument();

    // Auto-start schedules startTimer after 100ms
    act(() => {
      jest.advanceTimersByTime(200);
    });
    await flushTimersAndMicrotasks(user);

    expect(screen.getByRole("button", { name: /pause/i })).toBeInTheDocument();

    restoreDate();
  });
});
