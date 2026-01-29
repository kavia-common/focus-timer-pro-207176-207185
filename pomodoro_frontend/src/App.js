import React, { useEffect, useMemo, useRef, useState } from "react";
import "./App.css";

const STORAGE_KEYS = {
  settings: "pomodoro.settings.v1",
  stats: "pomodoro.stats.v1",
};

/**
 * @param {number} totalSeconds
 * @returns {string}
 */
function formatTime(totalSeconds) {
  const safe = Math.max(0, Math.floor(totalSeconds));
  const mm = String(Math.floor(safe / 60)).padStart(2, "0");
  const ss = String(safe % 60).padStart(2, "0");
  return `${mm}:${ss}`;
}

/**
 * @returns {string} YYYY-MM-DD in local time
 */
function todayKey() {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

/**
 * @template T
 * @param {string} key
 * @param {T} fallback
 * @returns {T}
 */
function loadJSON(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    return /** @type {T} */ (JSON.parse(raw));
  } catch {
    return fallback;
  }
}

/**
 * @param {string} key
 * @param {unknown} value
 */
function saveJSON(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Ignore storage failures (private mode, quota, etc.)
  }
}

/**
 * @typedef {"work"|"break"} Phase
 */

/**
 * @typedef {Object} Settings
 * @property {number} workMinutes
 * @property {number} breakMinutes
 * @property {boolean} autoStartNext
 */

/**
 * @typedef {Object} DailyStats
 * @property {number} completedPomodoros
 */

/**
 * @typedef {Record<string, DailyStats>} StatsByDay
 */

const DEFAULT_SETTINGS = /** @type {Settings} */ ({
  workMinutes: 25,
  breakMinutes: 5,
  autoStartNext: false,
});

// PUBLIC_INTERFACE
function App() {
  /** Retro UI theme: keep app light, but with neon/CRT styling in CSS. */
  const [settings, setSettings] = useState(() =>
    loadJSON(STORAGE_KEYS.settings, DEFAULT_SETTINGS)
  );

  const [phase, setPhase] = useState(/** @type {Phase} */ ("work"));
  const [isRunning, setIsRunning] = useState(false);

  // Total seconds remaining for the current phase
  const [remainingSeconds, setRemainingSeconds] = useState(() => {
    return Math.round(settings.workMinutes * 60);
  });

  const [statsByDay, setStatsByDay] = useState(
    /** @type {StatsByDay} */ () => loadJSON(STORAGE_KEYS.stats, {})
  );

  const [settingsOpen, setSettingsOpen] = useState(false);
  const [toast, setToast] = useState("");

  const timerIntervalRef = useRef(/** @type {number | null} */ (null));
  const lastTickAtRef = useRef(/** @type {number | null} */ (null));
  const endAtRef = useRef(/** @type {number | null} */ (null));
  const toastTimeoutRef = useRef(/** @type {number | null} */ (null));

  const totalSeconds = useMemo(() => {
    return Math.round((phase === "work" ? settings.workMinutes : settings.breakMinutes) * 60);
  }, [phase, settings.breakMinutes, settings.workMinutes]);

  const progress = useMemo(() => {
    if (totalSeconds <= 0) return 0;
    const elapsed = totalSeconds - remainingSeconds;
    return Math.max(0, Math.min(1, elapsed / totalSeconds));
  }, [remainingSeconds, totalSeconds]);

  // Persist settings + stats
  useEffect(() => {
    saveJSON(STORAGE_KEYS.settings, settings);
  }, [settings]);

  useEffect(() => {
    saveJSON(STORAGE_KEYS.stats, statsByDay);
  }, [statsByDay]);

  // Keep remainingSeconds consistent when user changes settings while not running
  useEffect(() => {
    if (isRunning) return;
    setRemainingSeconds(
      Math.round((phase === "work" ? settings.workMinutes : settings.breakMinutes) * 60)
    );
  }, [isRunning, phase, settings.breakMinutes, settings.workMinutes]);

  /**
   * Cleanup interval + timeouts on unmount
   */
  useEffect(() => {
    return () => {
      if (timerIntervalRef.current) window.clearInterval(timerIntervalRef.current);
      if (toastTimeoutRef.current) window.clearTimeout(toastTimeoutRef.current);
    };
  }, []);

  /**
   * Request notifications permission at first user interaction (button press).
   * We don't auto-prompt on load to avoid a hostile UX.
   */
  const requestNotificationPermission = async () => {
    if (!("Notification" in window)) return;
    if (Notification.permission === "default") {
      try {
        await Notification.requestPermission();
      } catch {
        // ignore
      }
    }
  };

  const showToast = (message) => {
    setToast(message);
    if (toastTimeoutRef.current) window.clearTimeout(toastTimeoutRef.current);
    toastTimeoutRef.current = window.setTimeout(() => setToast(""), 3000);
  };

  const playBeep = () => {
    // WebAudio beep - no external files needed.
    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtx) return;
      const ctx = new AudioCtx();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "square";
      osc.frequency.value = 880;

      gain.gain.setValueAtTime(0.0001, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.2, ctx.currentTime + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.25);

      osc.connect(gain);
      gain.connect(ctx.destination);

      osc.start();
      osc.stop(ctx.currentTime + 0.3);

      osc.onended = () => {
        try {
          ctx.close();
        } catch {
          // ignore
        }
      };
    } catch {
      // ignore audio failures
    }
  };

  const sendBrowserNotification = (title, body) => {
    if (!("Notification" in window)) return;
    if (Notification.permission !== "granted") return;

    try {
      // Some browsers require HTTPS for notifications; if it fails, we still show toast.
      // eslint-disable-next-line no-new
      new Notification(title, { body });
    } catch {
      // ignore
    }
  };

  const stopInterval = () => {
    if (timerIntervalRef.current) {
      window.clearInterval(timerIntervalRef.current);
      timerIntervalRef.current = null;
    }
    lastTickAtRef.current = null;
    endAtRef.current = null;
  };

  const completeWorkSession = () => {
    const key = todayKey();
    setStatsByDay((prev) => {
      const current = prev[key] || { completedPomodoros: 0 };
      return {
        ...prev,
        [key]: {
          completedPomodoros: current.completedPomodoros + 1,
        },
      };
    });
  };

  const switchPhase = (nextPhase) => {
    setPhase(nextPhase);
    setRemainingSeconds(
      Math.round((nextPhase === "work" ? settings.workMinutes : settings.breakMinutes) * 60)
    );
  };

  /**
   * Called when the timer reaches 0.
   */
  const handlePhaseEnd = () => {
    stopInterval();
    setIsRunning(false);

    if (phase === "work") completeWorkSession();

    const nextPhase = phase === "work" ? "break" : "work";
    const title = phase === "work" ? "Work complete" : "Break complete";
    const body =
      phase === "work"
        ? "Take a short break. You earned it."
        : "Break's over. Back to focus time.";

    playBeep();
    sendBrowserNotification(title, body);
    showToast(`${title}. ${body}`);

    switchPhase(nextPhase);

    if (settings.autoStartNext) {
      // Start after state updates have applied
      window.setTimeout(() => {
        startTimer();
      }, 100);
    }
  };

  const tick = () => {
    const now = Date.now();

    // Use a target end-time to avoid drift when the tab is inactive.
    if (endAtRef.current == null) {
      endAtRef.current = now + remainingSeconds * 1000;
      lastTickAtRef.current = now;
    }

    const msLeft = endAtRef.current - now;
    const newRemaining = Math.ceil(msLeft / 1000);

    if (newRemaining <= 0) {
      setRemainingSeconds(0);
      handlePhaseEnd();
      return;
    }

    // Only update state if it changed (reduces re-renders)
    setRemainingSeconds((prev) => (prev !== newRemaining ? newRemaining : prev));
    lastTickAtRef.current = now;
  };

  const startTimer = async () => {
    await requestNotificationPermission();
    if (isRunning) return;

    // Ensure consistent endAt based on current remainingSeconds
    endAtRef.current = Date.now() + remainingSeconds * 1000;
    lastTickAtRef.current = Date.now();

    setIsRunning(true);

    if (!timerIntervalRef.current) {
      timerIntervalRef.current = window.setInterval(tick, 250);
    }
  };

  const pauseTimer = () => {
    if (!isRunning) return;
    setIsRunning(false);

    // Freeze remaining based on endAtRef
    if (endAtRef.current != null) {
      const msLeft = endAtRef.current - Date.now();
      setRemainingSeconds(Math.max(0, Math.ceil(msLeft / 1000)));
    }

    stopInterval();
  };

  const resetTimer = () => {
    setIsRunning(false);
    stopInterval();
    setRemainingSeconds(Math.round((phase === "work" ? settings.workMinutes : settings.breakMinutes) * 60));
    showToast("Reset.");
  };

  const skipPhase = () => {
    setIsRunning(false);
    stopInterval();
    const nextPhase = phase === "work" ? "break" : "work";
    switchPhase(nextPhase);
    showToast(`Skipped to ${nextPhase === "work" ? "Work" : "Break"}.`);
  };

  const canNotify = "Notification" in window;
  const notifStatus = canNotify ? Notification.permission : "unsupported";

  const today = todayKey();
  const todaysCompleted = statsByDay[today]?.completedPomodoros ?? 0;

  const title = phase === "work" ? "FOCUS" : "CHILL";
  const subtitle = phase === "work" ? "Work Session" : "Break Session";

  return (
    <div className="App">
      <div className="crt" aria-hidden="true" />
      <header className="topbar">
        <div className="brand">
          <div className="brandMark" aria-hidden="true">
            FT
          </div>
          <div className="brandText">
            <div className="brandName">Focus Timer Pro</div>
            <div className="brandTag">Retro productivity console</div>
          </div>
        </div>

        <div className="topActions">
          <button
            className="btn btnGhost"
            onClick={() => setSettingsOpen(true)}
            aria-haspopup="dialog"
            aria-expanded={settingsOpen}
          >
            Settings
          </button>
        </div>
      </header>

      <main className="container">
        <section className="panel">
          <div className="panelHeader">
            <div className="phaseTitle">
              <div className="phaseKicker">{subtitle}</div>
              <h1 className="phaseMain">{title}</h1>
            </div>

            <div className="phaseMeta">
              <div className="metaChip" title="Notification permission state">
                <span className="metaLabel">Notify</span>
                <span className="metaValue">
                  {notifStatus === "granted"
                    ? "ON"
                    : notifStatus === "denied"
                      ? "BLOCKED"
                      : notifStatus === "default"
                        ? "ASK"
                        : "N/A"}
                </span>
              </div>
              <div className="metaChip" title="Completed Pomodoro work sessions today">
                <span className="metaLabel">Today</span>
                <span className="metaValue">{todaysCompleted}</span>
              </div>
            </div>
          </div>

          <div className="timerWrap">
            <div className="ring" role="img" aria-label={`Timer progress ${Math.round(progress * 100)}%`}>
              <svg viewBox="0 0 120 120" className="ringSvg" aria-hidden="true">
                <circle className="ringTrack" cx="60" cy="60" r="46" />
                <circle
                  className="ringProgress"
                  cx="60"
                  cy="60"
                  r="46"
                  style={{
                    strokeDasharray: 2 * Math.PI * 46,
                    strokeDashoffset: (1 - progress) * (2 * Math.PI * 46),
                  }}
                />
              </svg>

              <div className="timeStack">
                <div className="timeBig" aria-live="polite">
                  {formatTime(remainingSeconds)}
                </div>
                <div className="timeSmall">
                  {phase === "work" ? `${settings.workMinutes} min work` : `${settings.breakMinutes} min break`}
                </div>
              </div>
            </div>

            <div className="controls" role="group" aria-label="Timer controls">
              {!isRunning ? (
                <button className="btn btnPrimary btnLarge" onClick={startTimer}>
                  Start
                </button>
              ) : (
                <button className="btn btnPrimary btnLarge" onClick={pauseTimer}>
                  Pause
                </button>
              )}
              <button className="btn btnSecondary" onClick={resetTimer}>
                Reset
              </button>
              <button className="btn btnGhost" onClick={skipPhase}>
                Skip
              </button>
            </div>

            <div className="hint">
              Tip: notifications need user permission. Press <strong>Start</strong> once to allow.
            </div>
          </div>

          {toast ? (
            <div className="toast" role="status" aria-live="polite">
              <span className="toastDot" aria-hidden="true" />
              {toast}
            </div>
          ) : null}
        </section>

        <section className="panel panelStats" aria-label="Daily statistics">
          <h2 className="sectionTitle">Daily Stats</h2>
          <div className="statsGrid">
            <div className="statCard">
              <div className="statLabel">Completed Pomodoros</div>
              <div className="statValue">{todaysCompleted}</div>
              <div className="statSub">Counts completed work sessions (25 min by default).</div>
            </div>

            <div className="statCard">
              <div className="statLabel">Mode</div>
              <div className="statValue">{phase === "work" ? "Focus" : "Break"}</div>
              <div className="statSub">Next phase switches automatically on completion.</div>
            </div>

            <div className="statCard">
              <div className="statLabel">Auto-start next</div>
              <div className="statValue">{settings.autoStartNext ? "Yes" : "No"}</div>
              <div className="statSub">Enable in Settings if you want continuous cycles.</div>
            </div>
          </div>
        </section>
      </main>

      {settingsOpen ? (
        <div className="modalOverlay" role="presentation" onMouseDown={() => setSettingsOpen(false)}>
          <div
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-label="Pomodoro settings"
            onMouseDown={(e) => e.stopPropagation()}
          >
            <div className="modalHeader">
              <h2 className="modalTitle">Settings</h2>
              <button className="iconBtn" onClick={() => setSettingsOpen(false)} aria-label="Close settings">
                ×
              </button>
            </div>

            <div className="formGrid">
              <label className="field">
                <span className="fieldLabel">Work minutes</span>
                <input
                  className="input"
                  type="number"
                  min={1}
                  max={180}
                  value={settings.workMinutes}
                  onChange={(e) => {
                    const v = Number(e.target.value);
                    setSettings((prev) => ({ ...prev, workMinutes: Number.isFinite(v) ? v : prev.workMinutes }));
                  }}
                />
                <span className="fieldHint">Typical: 25</span>
              </label>

              <label className="field">
                <span className="fieldLabel">Break minutes</span>
                <input
                  className="input"
                  type="number"
                  min={1}
                  max={60}
                  value={settings.breakMinutes}
                  onChange={(e) => {
                    const v = Number(e.target.value);
                    setSettings((prev) => ({ ...prev, breakMinutes: Number.isFinite(v) ? v : prev.breakMinutes }));
                  }}
                />
                <span className="fieldHint">Typical: 5</span>
              </label>

              <label className="field fieldRow">
                <span className="fieldLabel">Auto-start next phase</span>
                <input
                  className="toggle"
                  type="checkbox"
                  checked={settings.autoStartNext}
                  onChange={(e) => setSettings((prev) => ({ ...prev, autoStartNext: e.target.checked }))}
                />
              </label>
            </div>

            <div className="modalFooter">
              <button
                className="btn btnGhost"
                onClick={() => {
                  setSettings(DEFAULT_SETTINGS);
                  showToast("Settings restored to defaults.");
                }}
              >
                Restore defaults
              </button>

              <div className="modalFooterRight">
                <button className="btn btnSecondary" onClick={() => setSettingsOpen(false)}>
                  Done
                </button>
              </div>
            </div>

            <div className="modalNote">
              <strong>Note:</strong> If you change intervals while the timer is paused, the display updates immediately.
              If it’s running, changes apply after the current phase ends (or you Reset).
            </div>
          </div>
        </div>
      ) : null}

      <footer className="footer">
        <div className="footerInner">
          <span className="footerDim">Local-only • No backend needed</span>
          <span className="footerSep" aria-hidden="true">
            |
          </span>
          <span className="footerDim">Shortcut: Start/Pause/Reset via buttons</span>
        </div>
      </footer>
    </div>
  );
}

export default App;
