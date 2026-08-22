@cp5
Feature: The exit is a command, not a hope
  As a solo founder with no funds
  I want one command to take the code and the data off the provider
  So that a provider who knows I cannot leave cannot price me

  Scenario: the whole repository leaves in one command
    When I bundle the repository to local disk
    Then the bundle verifies
    And the bundle contains the control plane source

  Scenario: the object store empties onto local disk
    Given the lab is up
    When I mirror the lab object store to local disk
    Then the mirror exits cleanly

  Scenario: the drill refuses to report green when the copy fails
    When the exit drill runs with no object-store client
    Then it exits non-zero
    And it never prints "EXIT DRILL GREEN"
