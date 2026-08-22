@cp3
Feature: Cold start from a park bench, with the data
  As a solo founder
  I want one Telegram line to rebuild the box and bring the orders back
  So that I can recover with a phone and no laptop

  Background:
    Given the lab is up

  Scenario: every box is gone and a phone brings one back with its data
    Given no boxes are running
    And a "primary" box is registered and healthy
    And an order is written to the primary
    And the write has reached object storage
    When every box is destroyed
    And I cold start from Telegram
    Then a primary box is healthy within 300 seconds
    And the restored box carries every order that was written
