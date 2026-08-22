@cp4
Feature: Every box is ash and the shop still sells
  As a solo founder
  I want the edge to serve the catalogue and queue orders when the origin is dead
  So that an outage costs me latency, not revenue

  Background:
    Given the lab is up

  Scenario: the catalogue renders and an order is still taken
    When every box is destroyed
    Then the degraded page shows the catalogue within 30 seconds
    And an order is accepted by the control plane
    And the audit log mentions degraded mode
