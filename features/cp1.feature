@cp1
Feature: The control plane answers, and refuses everything it should
  As a solo founder
  I want one Worker that is always reachable and always suspicious
  So that the recovery path has no machine in it that can die

  Background:
    Given the lab is up

  Scenario: the Worker says what it is
    When I GET "/health" on the control plane
    Then the response status is 200
    And the response contains "survival-control-plane"

  Scenario: the Telegram webhook refuses a caller without the shared secret
    When a forged Telegram message "/status" arrives
    Then the response status is not 200

  Scenario: the bot answers a real message from the phone
    Given the Telegram outbox is empty
    When a Telegram message "/status" arrives
    Then the bot replies within 30 seconds

  Scenario: a command that spends money is refused without a TOTP code
    Given the Telegram outbox is empty
    When a Telegram message "/cold-start docker" arrives
    Then the bot replies within 30 seconds
    And no reply mentions "Creating VM"

  Scenario: a control plane with no TOTP secret refuses rather than falling open
    When I POST an action with no code
    Then the response status is not 200
