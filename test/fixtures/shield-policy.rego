package airkit.shield

default decision := {
  "action": "allow",
  "reasonCodes": [],
  "approvalEligible": false,
  "redactions": [],
}

decision := {
  "action": "block",
  "reasonCodes": ["confirmed-secret"],
  "approvalEligible": false,
  "redactions": [],
} if {
  count(input.secretFindings) > 0
}

decision := {
  "action": "block",
  "reasonCodes": ["restricted-data"],
  "approvalEligible": false,
  "redactions": [],
} if {
  count(input.secretFindings) == 0
  input.repositoryClass == "restricted"
}

decision := {
  "action": "block",
  "reasonCodes": ["restricted-data"],
  "approvalEligible": false,
  "redactions": [],
} if {
  count(input.secretFindings) == 0
  input.repositoryClass != "restricted"
  some pathClass in input.pathClasses
  restricted_path_class(pathClass)
}

decision := {
  "action": "require_approval",
  "reasonCodes": ["internal-subscription"],
  "approvalEligible": true,
  "redactions": [],
} if {
  count(input.secretFindings) == 0
  input.repositoryClass == "internal"
  input.destinationClass == "subscription"
  not has_restricted_path
  not has_pii_redaction
}

decision := {
  "action": "redact",
  "reasonCodes": ["pii-redaction"],
  "approvalEligible": false,
  "redactions": [],
} if {
  count(input.secretFindings) == 0
  input.repositoryClass != "restricted"
  not has_restricted_path
  has_pii_redaction
}

has_restricted_path if {
  some pathClass in input.pathClasses
  restricted_path_class(pathClass)
}

has_pii_redaction if {
  some finding in input.piiFindings
  finding.category == "email"
  finding.count > 0
}

restricted_path_class("environment")
restricted_path_class("terraform_state")
restricted_path_class("credential_store")
restricted_path_class("production_config")
