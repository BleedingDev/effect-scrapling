import { type PatchrightPage } from "./browser-pool.ts";

const CLOUDFLARE_CHALLENGE_FRAME_PATTERN =
  /^https?:\/\/challenges\.cloudflare\.com\/cdn-cgi\/challenge-platform\/.*/iu;
const JUST_A_MOMENT_TITLE = "<title>Just a moment...</title>";
const CLOUDFLARE_TURNSTILE_SCRIPT_PATTERN =
  /<script[^>]+src=["'][^"']*challenges\.cloudflare\.com\/turnstile\/v/iu;
const CLOUDFLARE_CHALLENGE_TYPE_PATTERN = /cType:\s*['"]([^'"]+)['"]/iu;
const MANAGED_CHALLENGE_VERIFY_TEXT = "Verifying you are human.";
const DEFAULT_TURNSTILE_CLICK_X_OFFSET = 27;
const DEFAULT_TURNSTILE_CLICK_Y_OFFSET = 26;
const DEFAULT_CLICK_DELAY_MS = 150;
const NETWORK_SETTLE_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_CLOUDFLARE_SOLVER_ATTEMPTS = 2;
const CLEARANCE_POLL_INTERVAL_MS = 250;
const MANAGED_SPINNER_POLL_INTERVAL_MS = 500;
const MAX_EMBEDDED_ATTEMPT_CLEARANCE_WINDOW_MS = 750;
const MAX_MANAGED_ATTEMPT_CLEARANCE_WINDOW_MS = 10_000;
const INITIAL_CHALLENGE_EMERGENCE_WINDOW_MS = 2_000;
const MAX_TRANSIENT_CONTENT_READ_ATTEMPTS = 3;

export type CloudflareChallengeType = "non-interactive" | "managed" | "interactive" | "embedded";

export type BrowserChallengeHandlingOptions = {
  readonly solveCloudflare?: boolean | undefined;
};

export type BrowserChallengeResolutionKind = "wait" | "click";

export type BrowserChallengeFailureReason =
  | "no-progress"
  | "budget-exhausted"
  | "unsupported-surface";

export type BrowserChallengeResolution = {
  readonly detected: boolean;
  readonly followUpNavigationRequired: boolean;
  readonly currentPageRefreshRequired: boolean;
  readonly challengeType?: CloudflareChallengeType | undefined;
  readonly resolutionKind?: BrowserChallengeResolutionKind | undefined;
  readonly failureReason?: BrowserChallengeFailureReason | undefined;
  readonly attemptCount: number;
  readonly warnings: ReadonlyArray<string>;
};

type Box = {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
};

type ChallengeState = {
  readonly html: string;
  readonly type: CloudflareChallengeType | undefined;
  readonly waitingInterstitial: boolean;
  readonly verifyingHuman: boolean;
};

type ChallengeIterationResult =
  | {
      readonly cleared: true;
    }
  | {
      readonly cleared: false;
      readonly exhausted: boolean;
    };

function toSolverWarning(message: string) {
  return `cloudflare-solver:${message}`;
}

export function detectCloudflareChallengeType(
  pageContent: string,
): CloudflareChallengeType | undefined {
  const matchedChallengeType = CLOUDFLARE_CHALLENGE_TYPE_PATTERN.exec(pageContent)?.[1];
  if (
    matchedChallengeType === "non-interactive" ||
    matchedChallengeType === "managed" ||
    matchedChallengeType === "interactive"
  ) {
    return matchedChallengeType;
  }

  if (CLOUDFLARE_TURNSTILE_SCRIPT_PATTERN.test(pageContent)) {
    return "embedded";
  }

  return undefined;
}

async function pause(page: PatchrightPage, timeoutMs: number) {
  if (timeoutMs <= 0) {
    return;
  }

  if (page.waitForTimeout !== undefined) {
    await page.waitForTimeout(timeoutMs);
    return;
  }

  await new Promise<void>((resolve) => {
    setTimeout(resolve, timeoutMs);
  });
}

async function waitForNetworkSettle(page: PatchrightPage, timeoutMs: number) {
  try {
    await page.waitForLoadState("networkidle", {
      timeout: Math.max(1, Math.min(timeoutMs, NETWORK_SETTLE_TIMEOUT_MS)),
    });
  } catch {
    // Some challenge pages never reach a stable network-idle state. The solver keeps going.
  }
}

async function resolveFrameBoundingBox(page: PatchrightPage) {
  const frame = page.frame?.({
    url: CLOUDFLARE_CHALLENGE_FRAME_PATTERN,
  });
  if (frame === undefined || frame === null) {
    return undefined;
  }

  const frameElement = await frame.frameElement();
  if (!(await frameElement.isVisible())) {
    return undefined;
  }

  const boundingBox = await frameElement.boundingBox();
  return boundingBox ?? undefined;
}

async function resolveLocatorBoundingBox(page: PatchrightPage, selector: string) {
  const locator = page.locator?.(selector);
  if (locator === undefined) {
    return undefined;
  }

  const target = locator.last?.() ?? locator;
  if (target.isVisible !== undefined && !(await target.isVisible())) {
    return undefined;
  }

  const boundingBox = await target.boundingBox();
  return boundingBox ?? undefined;
}

async function resolveTurnstileBoundingBox(
  page: PatchrightPage,
  challengeType: CloudflareChallengeType,
) {
  const frameBoundingBox = await resolveFrameBoundingBox(page);
  if (frameBoundingBox !== undefined) {
    return frameBoundingBox;
  }

  if (challengeType === "embedded") {
    return resolveLocatorBoundingBox(
      page,
      "#cf_turnstile div, #cf-turnstile div, .turnstile>div>div",
    );
  }

  return resolveLocatorBoundingBox(page, ".main-content p+div>div>div");
}

async function waitForTurnstileBoundingBox(
  page: PatchrightPage,
  challengeType: CloudflareChallengeType,
  deadlineAt: number,
) {
  while (Date.now() < deadlineAt) {
    const boundingBox = await resolveTurnstileBoundingBox(page, challengeType);
    if (boundingBox !== undefined) {
      return boundingBox;
    }

    await pause(page, CLEARANCE_POLL_INTERVAL_MS);
  }

  return undefined;
}

async function readChallengeState(page: PatchrightPage): Promise<ChallengeState> {
  let lastError: unknown;
  for (
    let attemptIndex = 0;
    attemptIndex < MAX_TRANSIENT_CONTENT_READ_ATTEMPTS;
    attemptIndex += 1
  ) {
    try {
      const html = await page.content();
      return {
        html,
        type: detectCloudflareChallengeType(html),
        waitingInterstitial: html.includes(JUST_A_MOMENT_TITLE),
        verifyingHuman: html.includes(MANAGED_CHALLENGE_VERIFY_TEXT),
      };
    } catch (error) {
      lastError = error;
      const details =
        error instanceof Error
          ? `${error.name}: ${error.message}`
          : typeof error === "string"
            ? error
            : "";
      const isTransientNavigationRace =
        details.includes("page is navigating") || details.includes("changing the content");
      if (!isTransientNavigationRace || attemptIndex + 1 >= MAX_TRANSIENT_CONTENT_READ_ATTEMPTS) {
        throw error;
      }
      await pause(page, CLEARANCE_POLL_INTERVAL_MS);
    }
  }

  throw lastError;
}

function hasChallengeEmergenceSignal(pageContent: string) {
  return pageContent.includes(JUST_A_MOMENT_TITLE);
}

function buildChallengeSignature(state: ChallengeState) {
  return [
    state.type ?? "none",
    state.waitingInterstitial ? "waiting" : "ready",
    state.verifyingHuman ? "verifying" : "stable",
  ].join(":");
}

function isChallengeCleared(state: ChallengeState) {
  return !state.waitingInterstitial && state.type === undefined;
}

function resolveAttemptDeadline(
  globalDeadlineAt: number,
  attemptIndex: number,
  maxAttempts: number,
  challengeType: CloudflareChallengeType,
) {
  const remainingAttempts = Math.max(1, maxAttempts - attemptIndex);
  const remainingMs = Math.max(1, globalDeadlineAt - Date.now());
  const maxAttemptWindowMs =
    challengeType === "embedded"
      ? MAX_EMBEDDED_ATTEMPT_CLEARANCE_WINDOW_MS
      : MAX_MANAGED_ATTEMPT_CLEARANCE_WINDOW_MS;
  const attemptBudgetMs = Math.max(
    CLEARANCE_POLL_INTERVAL_MS,
    Math.min(maxAttemptWindowMs, Math.ceil(remainingMs / remainingAttempts)),
  );
  return Math.min(globalDeadlineAt, Date.now() + attemptBudgetMs);
}

async function waitForChallengeToClear(page: PatchrightPage, deadlineAt: number) {
  while (Date.now() < deadlineAt) {
    const state = await readChallengeState(page);
    if (isChallengeCleared(state)) {
      return true;
    }
    await pause(page, CLEARANCE_POLL_INTERVAL_MS);
  }

  return false;
}

async function waitForChallengeIteration(
  page: PatchrightPage,
  deadlineAt: number,
  baselineSignature: string,
): Promise<ChallengeIterationResult> {
  while (Date.now() < deadlineAt) {
    const state = await readChallengeState(page);
    if (isChallengeCleared(state)) {
      return {
        cleared: true,
      };
    }

    if (buildChallengeSignature(state) !== baselineSignature) {
      return {
        cleared: false,
        exhausted: false,
      };
    }

    await pause(page, CLEARANCE_POLL_INTERVAL_MS);
  }

  return {
    cleared: false,
    exhausted: true,
  };
}

async function waitForManagedSpinnerToSettle(page: PatchrightPage, deadlineAt: number) {
  while (Date.now() < deadlineAt) {
    const state = await readChallengeState(page);
    if (!state.verifyingHuman) {
      return;
    }
    await pause(page, MANAGED_SPINNER_POLL_INTERVAL_MS);
  }
}

async function dispatchTurnstileClick(page: PatchrightPage, box: Box) {
  if (page.mouse === undefined) {
    throw new Error("missing-mouse");
  }

  await page.mouse.click(
    box.x + DEFAULT_TURNSTILE_CLICK_X_OFFSET,
    box.y + DEFAULT_TURNSTILE_CLICK_Y_OFFSET,
    {
      delay: DEFAULT_CLICK_DELAY_MS,
      button: "left",
    },
  );
}

function makeNoChallengeResolution(): BrowserChallengeResolution {
  return {
    detected: false,
    followUpNavigationRequired: false,
    currentPageRefreshRequired: false,
    attemptCount: 0,
    warnings: [],
  };
}

async function resolveInitialChallengeState(
  page: PatchrightPage,
  pageContent: string,
  timeoutMs: number,
) {
  const initialState: ChallengeState = {
    html: pageContent,
    type: detectCloudflareChallengeType(pageContent),
    waitingInterstitial: pageContent.includes(JUST_A_MOMENT_TITLE),
    verifyingHuman: pageContent.includes(MANAGED_CHALLENGE_VERIFY_TEXT),
  };
  if (initialState.type !== undefined || !hasChallengeEmergenceSignal(pageContent)) {
    return initialState;
  }

  const emergenceDeadlineAt =
    Date.now() + Math.max(1, Math.min(timeoutMs, INITIAL_CHALLENGE_EMERGENCE_WINDOW_MS));
  await waitForNetworkSettle(page, timeoutMs);
  let candidateState = await readChallengeState(page);
  while (
    candidateState.type === undefined &&
    candidateState.waitingInterstitial &&
    Date.now() < emergenceDeadlineAt
  ) {
    await pause(page, CLEARANCE_POLL_INTERVAL_MS);
    candidateState = await readChallengeState(page);
  }
  return candidateState;
}

export async function resolveBrowserChallenges(input: {
  readonly page: PatchrightPage;
  readonly pageContent: string;
  readonly timeoutMs: number;
  readonly maxAttempts?: number | undefined;
  readonly challengeHandling?: BrowserChallengeHandlingOptions | undefined;
}): Promise<BrowserChallengeResolution> {
  if (input.challengeHandling?.solveCloudflare !== true) {
    return makeNoChallengeResolution();
  }

  const initialState = await resolveInitialChallengeState(
    input.page,
    input.pageContent,
    input.timeoutMs,
  );
  const weakInterstitialAutoCleared =
    hasChallengeEmergenceSignal(input.pageContent) &&
    initialState.html !== input.pageContent &&
    isChallengeCleared(initialState);
  const challengeType = initialState.type;
  if (challengeType === undefined) {
    if (weakInterstitialAutoCleared) {
      return {
        detected: false,
        followUpNavigationRequired: false,
        currentPageRefreshRequired: true,
        attemptCount: 0,
        warnings: [toSolverWarning("weak-interstitial-cleared-before-marker-detection")],
      };
    }
    return makeNoChallengeResolution();
  }

  const warnings =
    initialState.html === input.pageContent
      ? [toSolverWarning(`detected:${challengeType}`)]
      : [
          toSolverWarning("challenge-emerged-after-initial-dom-read"),
          toSolverWarning(`detected:${challengeType}`),
        ];
  const deadlineAt = Date.now() + Math.max(1, input.timeoutMs);
  const maxAttempts = Math.max(1, input.maxAttempts ?? DEFAULT_MAX_CLOUDFLARE_SOLVER_ATTEMPTS);

  await waitForNetworkSettle(input.page, input.timeoutMs);

  let currentType = challengeType;
  let attemptCount = 0;
  let repeatedSignatureCount = 0;
  let observedStateChange = false;
  let previousSignature: string | undefined;

  for (
    let attemptIndex = 0;
    attemptIndex < maxAttempts && Date.now() < deadlineAt;
    attemptIndex += 1
  ) {
    const stateBeforeAttempt =
      attemptIndex === 0 ? initialState : await readChallengeState(input.page);
    if (isChallengeCleared(stateBeforeAttempt)) {
      return {
        detected: true,
        followUpNavigationRequired: true,
        currentPageRefreshRequired: true,
        challengeType: currentType,
        resolutionKind: attemptCount > 0 ? "click" : "wait",
        attemptCount,
        warnings: [...warnings, toSolverWarning(`clearance-observed:${currentType}`)],
      };
    }

    currentType = stateBeforeAttempt.type ?? currentType;
    const attemptDeadlineAt = resolveAttemptDeadline(
      deadlineAt,
      attemptIndex,
      maxAttempts,
      currentType,
    );

    if (currentType === "non-interactive") {
      const currentSignature = buildChallengeSignature(stateBeforeAttempt);
      repeatedSignatureCount =
        currentSignature === previousSignature ? repeatedSignatureCount + 1 : 0;
      previousSignature = currentSignature;
      const clearanceObserved = await waitForChallengeToClear(input.page, deadlineAt);
      return {
        detected: true,
        followUpNavigationRequired: clearanceObserved,
        currentPageRefreshRequired: clearanceObserved,
        challengeType: currentType,
        resolutionKind: "wait",
        ...(clearanceObserved
          ? {}
          : {
              failureReason:
                Date.now() >= deadlineAt ? ("budget-exhausted" as const) : ("no-progress" as const),
            }),
        attemptCount,
        warnings: [
          ...warnings,
          toSolverWarning(
            clearanceObserved
              ? `clearance-observed:${currentType}`
              : `clearance-missing:${currentType}`,
          ),
        ],
      };
    }

    await waitForManagedSpinnerToSettle(input.page, attemptDeadlineAt);
    const stateAfterSettle = await readChallengeState(input.page);
    if (isChallengeCleared(stateAfterSettle)) {
      return {
        detected: true,
        followUpNavigationRequired: true,
        currentPageRefreshRequired: true,
        challengeType: currentType,
        resolutionKind: "wait",
        attemptCount,
        warnings: [...warnings, toSolverWarning(`clearance-observed:${currentType}`)],
      };
    }
    currentType = stateAfterSettle.type ?? currentType;
    const currentSignature = buildChallengeSignature(stateAfterSettle);
    repeatedSignatureCount =
      currentSignature === previousSignature ? repeatedSignatureCount + 1 : 0;
    previousSignature = currentSignature;

    const targetBoundingBox = await waitForTurnstileBoundingBox(
      input.page,
      currentType,
      attemptDeadlineAt,
    );
    if (targetBoundingBox === undefined) {
      const stateAfterTargetMiss = await readChallengeState(input.page);
      if (isChallengeCleared(stateAfterTargetMiss)) {
        return {
          detected: true,
          followUpNavigationRequired: true,
          currentPageRefreshRequired: true,
          challengeType: currentType,
          resolutionKind: attemptCount > 0 ? "click" : "wait",
          attemptCount,
          warnings: [...warnings, toSolverWarning(`clearance-observed:${currentType}`)],
        };
      }

      warnings.push(toSolverWarning(`target-missing:${currentType}`));
      if (attemptIndex + 1 < maxAttempts && Date.now() < deadlineAt) {
        warnings.push(toSolverWarning(`retrying:${currentType}`));
        await pause(input.page, CLEARANCE_POLL_INTERVAL_MS);
        continue;
      }
      return {
        detected: true,
        followUpNavigationRequired: false,
        currentPageRefreshRequired: false,
        challengeType: currentType,
        resolutionKind: "click",
        failureReason: "no-progress",
        attemptCount,
        warnings,
      };
    }

    try {
      await dispatchTurnstileClick(input.page, targetBoundingBox);
    } catch {
      return {
        detected: true,
        followUpNavigationRequired: false,
        currentPageRefreshRequired: false,
        challengeType: currentType,
        resolutionKind: "click",
        failureReason: "unsupported-surface",
        attemptCount,
        warnings: [...warnings, toSolverWarning("unsupported-page-api")],
      };
    }

    attemptCount += 1;
    warnings.push(toSolverWarning(`click-dispatched:${currentType}`));
    await waitForNetworkSettle(input.page, input.timeoutMs);

    const iteration = await waitForChallengeIteration(
      input.page,
      attemptDeadlineAt,
      currentSignature,
    );
    if (iteration.cleared) {
      return {
        detected: true,
        followUpNavigationRequired: true,
        currentPageRefreshRequired: true,
        challengeType: currentType,
        resolutionKind: "click",
        attemptCount,
        warnings: [...warnings, toSolverWarning(`clearance-observed:${currentType}`)],
      };
    }

    const stateAfterAttempt = await readChallengeState(input.page);
    currentType = stateAfterAttempt.type ?? currentType;
    const nextSignature = buildChallengeSignature(stateAfterAttempt);
    repeatedSignatureCount = nextSignature === previousSignature ? repeatedSignatureCount + 1 : 0;
    previousSignature = nextSignature;

    if (!iteration.exhausted) {
      observedStateChange = true;
      warnings.push(toSolverWarning(`state-changed:${currentType}`));
    } else if (attemptIndex + 1 < maxAttempts && repeatedSignatureCount > 0) {
      warnings.push(toSolverWarning(`retrying:${currentType}`));
    }
  }

  const failureReason =
    Date.now() >= deadlineAt ? ("budget-exhausted" as const) : ("no-progress" as const);

  return {
    detected: true,
    followUpNavigationRequired: false,
    currentPageRefreshRequired: observedStateChange,
    challengeType: currentType,
    resolutionKind: currentType === "non-interactive" ? "wait" : "click",
    failureReason,
    attemptCount,
    warnings: [
      ...warnings,
      toSolverWarning(
        failureReason === "budget-exhausted"
          ? `time-budget-exhausted:${currentType}`
          : `clearance-missing:${currentType}`,
      ),
    ],
  };
}
