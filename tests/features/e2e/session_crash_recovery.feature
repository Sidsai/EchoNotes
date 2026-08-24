# Realized as a Playwright E2E test (tests/e2e/crash-recovery.spec.ts), not a
# Cucumber-bound scenario: recovering a session inherently exercises real
# IndexedDB state and the app tab page's UI, which is exactly the boundary
# the plan draws between fast pipeline scenarios (bound to packages/core/,
# see screenshot_capture.feature and transcript_alignment.feature) and E2E
# scenarios (bound to a real browser). This file is kept as the literal
# scenario specification the PRD asked for.

Feature: Session crash recovery

  Scenario: Companion app crashes mid-session
    Given a capture session has been running for 10 minutes
    And 3 screenshots have been saved to disk
    When the companion app process is killed unexpectedly
    And the app is restarted
    Then the session is recoverable
    And no previously saved screenshots or transcript segments are lost
