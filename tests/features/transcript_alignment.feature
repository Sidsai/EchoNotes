Feature: Transcript-to-screenshot alignment

  Scenario: Screenshot attaches to the correct transcript segment
    Given a transcript with segments at 00:10, 00:45, and 01:20
    And a screenshot captured at timestamp 00:47
    When alignment runs
    Then the screenshot is linked to the segment starting at 00:45
