Feature: Screenshot capture on content change

  Scenario: A new slide triggers a screenshot
    Given a capture session is active
    And the shared screen shows "Slide 1"
    When the shared screen changes to "Slide 2"
    Then exactly one new screenshot is saved
    And its diff_score exceeds the configured threshold

  Scenario: Minor cursor movement does not trigger a screenshot
    Given a capture session is active
    And the shared screen shows a static slide
    When only the mouse cursor moves across the slide
    Then no new screenshot is saved

  Scenario: Rapid transition frames are debounced
    Given a capture session is active
    When the screen changes three times within 2 seconds during a slide animation
    Then only one screenshot is saved
    And it corresponds to the final settled frame
