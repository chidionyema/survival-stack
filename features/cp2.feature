@cp2
Feature: The standby takes over without me
  As a solo founder
  I want the edge to fall through to the standby when the primary dies
  So that I sleep through a 3am outage

  Background:
    Given the lab is up

  Scenario: the primary dies and the shop stays open
    Given no boxes are running
    And a "primary" box is registered and healthy
    And a "standby" box is registered and healthy
    Then the apex serves the "primary" within 60 seconds
    When the "primary" box is destroyed
    Then the control plane serves the "standby" within 60 seconds

  Scenario: promoting the standby moves the apex record
    Given a "standby" box is registered and healthy
    When I promote the standby
    Then the apex serves the "standby" within 60 seconds
