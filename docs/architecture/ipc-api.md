| Channel | Kind | Route | Idempotency key | Errors | Rate limit |
|---|---|---|---|---|---|
| `relay/v1/app.getInfo` | query | main | — | — | default |
| `relay/v1/app.getDiagnostics` | query | main+runner | — | `RUNNER_UNAVAILABLE` | default |
| `relay/v1/app.createBackup` | command | runner | required | `ARTIFACT_WRITE_FAILED`, `CONFLICT` | 5 / refill 0.2 per s |
| `relay/v1/app.exportDiagnostics` | command | main+runner | — | `ARTIFACT_WRITE_FAILED`, `NOT_FOUND` | 5 / refill 0.2 per s |
| `relay/v1/app.openExternal` | command | main | — | — | default |
| `relay/v1/app.getSettings` | query | runner | — | — | default |
| `relay/v1/app.updateSettings` | command | runner | — | `VALIDATION_FAILED` | default |
| `relay/v1/projects.pickDirectory` | command | main | — | `PERMISSION_DENIED`, `NOT_FOUND` | default |
| `relay/v1/projects.previewFiles` | query | main+runner | — | `NOT_FOUND`, `PERMISSION_DENIED` | default |
| `relay/v1/projects.create` | command | main+runner | required | `VALIDATION_FAILED`, `NOT_FOUND`, `CONFLICT`, `PERMISSION_DENIED` | default |
| `relay/v1/projects.list` | query | runner | — | — | default |
| `relay/v1/projects.get` | query | runner | — | `NOT_FOUND` | default |
| `relay/v1/projects.update` | command | runner | — | `CONFLICT`, `VALIDATION_FAILED`, `NOT_FOUND` | default |
| `relay/v1/projects.archive` | command | runner | — | `CONFLICT`, `NOT_FOUND` | default |
| `relay/v1/projects.export` | command | main+runner | — | `ARTIFACT_WRITE_FAILED`, `PERMISSION_DENIED`, `NOT_FOUND` | 5 / refill 0.2 per s |
| `relay/v1/projects.createSample` | command | main+runner | required | `ARTIFACT_WRITE_FAILED`, `CONFLICT`, `PERMISSION_DENIED` | default |
| `relay/v1/providers.list` | query | main+runner | — | — | default |
| `relay/v1/providers.connect` | command | main+runner | — | `SECURE_STORAGE_UNAVAILABLE`, `VALIDATION_FAILED`, `NOT_FOUND` | 10 / refill 0.1667 per s |
| `relay/v1/providers.test` | command | main+runner | — | `AUTH_REQUIRED`, `RATE_LIMITED`, `BUDGET_BLOCKED`, `MODEL_UNSUPPORTED` | 5 / refill 0.0833 per s |
| `relay/v1/providers.disconnect` | command | main+runner | — | `NOT_FOUND` | default |
| `relay/v1/providers.catalog` | query | runner | — | — | default |
| `relay/v1/profiles.list` | query | runner | — | — | default |
| `relay/v1/profiles.upsert` | command | runner | — | `MODEL_UNSUPPORTED`, `CONFLICT`, `NOT_FOUND` | default |
| `relay/v1/profiles.delete` | command | runner | — | `CONFLICT`, `NOT_FOUND` | default |
| `relay/v1/workflows.list` | query | runner | — | — | default |
| `relay/v1/workflows.get` | query | runner | — | `NOT_FOUND` | default |
| `relay/v1/workflows.saveDraft` | command | runner | — | `VALIDATION_FAILED`, `CONFLICT`, `NOT_FOUND` | default |
| `relay/v1/workflows.validate` | query | runner | — | `NOT_FOUND` | default |
| `relay/v1/workflows.publish` | command | runner | required | `VALIDATION_FAILED`, `NOT_FOUND`, `CONFLICT` | default |
| `relay/v1/runs.preflight` | query | runner | — | `MODEL_UNSUPPORTED`, `PERMISSION_DENIED`, `NOT_FOUND`, `CONFLICT` | default |
| `relay/v1/runs.start` | command | runner | required | `MODEL_UNSUPPORTED`, `PERMISSION_DENIED`, `VALIDATION_FAILED`, `NOT_FOUND`, `CONFLICT` | 10 / refill 0.5 per s |
| `relay/v1/runs.list` | query | runner | — | — | default |
| `relay/v1/runs.get` | query | runner | — | `NOT_FOUND` | default |
| `relay/v1/runs.getStep` | query | runner | — | `NOT_FOUND` | default |
| `relay/v1/runs.pause` | command | runner | — | `CONFLICT`, `NOT_FOUND` | default |
| `relay/v1/runs.resume` | command | runner | required | `AUTH_REQUIRED`, `VALIDATION_FAILED`, `CONFLICT`, `NOT_FOUND`, `MODEL_UNSUPPORTED`, `PERMISSION_DENIED`, `ARTIFACT_WRITE_FAILED` | 10 / refill 0.5 per s |
| `relay/v1/runs.cancel` | command | runner | — | `CONFLICT`, `NOT_FOUND` | default |
| `relay/v1/runs.increaseAllowance` | command | runner | required | `VALIDATION_FAILED`, `NOT_FOUND`, `CONFLICT` | default |
| `relay/v1/runs.decideUnknown` | command | runner | required | `CONFLICT`, `NOT_FOUND` | default |
| `relay/v1/runs.retryStep` | command | runner | required | `MODEL_UNSUPPORTED`, `PERMISSION_DENIED`, `CONFLICT`, `NOT_FOUND` | 10 / refill 0.5 per s |
| `relay/v1/runs.events` | query | runner | — | — | default |
| `relay/v1/approvals.decide` | command | runner | required | `APPROVAL_STALE`, `PROJECT_CHANGED`, `CONFLICT`, `NOT_FOUND` | default |
| `relay/v1/memory.list` | query | runner | — | — | default |
| `relay/v1/memory.get` | query | runner | — | `NOT_FOUND` | default |
| `relay/v1/memory.create` | command | runner | required | `VALIDATION_FAILED`, `PERMISSION_DENIED`, `NOT_FOUND`, `CONFLICT` | default |
| `relay/v1/memory.update` | command | runner | — | `CONFLICT`, `VALIDATION_FAILED`, `NOT_FOUND` | default |
| `relay/v1/memory.approve` | command | runner | — | `CONFLICT`, `VALIDATION_FAILED`, `NOT_FOUND` | default |
| `relay/v1/memory.reject` | command | runner | — | `CONFLICT`, `NOT_FOUND` | default |
| `relay/v1/memory.archive` | command | runner | — | `CONFLICT`, `NOT_FOUND` | default |
| `relay/v1/memory.delete` | command | runner | — | `NOT_FOUND`, `CONFLICT` | default |
| `relay/v1/memory.resolveConflict` | command | runner | required | `CONFLICT`, `VALIDATION_FAILED`, `NOT_FOUND` | default |
| `relay/v1/memory.purgeProjectHistory` | command | runner | — | `NOT_FOUND` | default |
| `relay/v1/artifacts.get` | query | runner | — | `NOT_FOUND` | default |
| `relay/v1/artifacts.importDiff` | command | main+runner | — | `VALIDATION_FAILED`, `PERMISSION_DENIED`, `NOT_FOUND`, `ARTIFACT_WRITE_FAILED` | default |
| `relay/v1/artifacts.export` | command | main+runner | — | `ARTIFACT_WRITE_FAILED`, `PERMISSION_DENIED`, `NOT_FOUND` | 5 / refill 0.2 per s |
| `relay/v1/ledger.runSummary` | query | runner | — | `NOT_FOUND` | default |
| `relay/v1/ledger.projectSummary` | query | runner | — | `NOT_FOUND` | default |
| `relay/v1/ledger.entries` | query | runner | — | — | default |
| `relay/v1/ledger.export` | command | main+runner | — | `ARTIFACT_WRITE_FAILED`, `PERMISSION_DENIED`, `NOT_FOUND` | 5 / refill 0.2 per s |

# Relay IPC API (v1)

> Generated by `pnpm gen:api-doc` from `@relay/contracts` `OPERATIONS`. Do not edit by hand.

Every operation may also return `VALIDATION_FAILED`, `RATE_LIMITED`, `RUNNER_UNAVAILABLE`, `PERMISSION_DENIED`, `INTERNAL`.
Results use the envelope `{ ok: true, data, meta? } | { ok: false, error: AppError }`.

## `app.getInfo`

Channel `relay/v1/app.getInfo` · query · route `main`

### Input

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {}
}
```

### Output

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "version": {
      "type": "string"
    },
    "buildId": {
      "type": "string"
    },
    "electron": {
      "type": "string"
    },
    "node": {
      "type": "string"
    },
    "platform": {
      "type": "string"
    },
    "userDataDisplayPath": {
      "type": "string"
    },
    "isPackaged": {
      "type": "boolean"
    },
    "providerMode": {
      "type": "string",
      "enum": [
        "live",
        "fake"
      ]
    },
    "fakeScenario": {
      "type": [
        "string",
        "null"
      ]
    }
  },
  "required": [
    "version",
    "buildId",
    "electron",
    "node",
    "platform",
    "userDataDisplayPath",
    "isPackaged",
    "providerMode",
    "fakeScenario"
  ]
}
```

## `app.getDiagnostics`

Channel `relay/v1/app.getDiagnostics` · query · route `main+runner`

### Input

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {}
}
```

### Output

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "runner": {
      "type": "object",
      "properties": {
        "state": {
          "type": "string",
          "enum": [
            "starting",
            "ready",
            "restarting",
            "unavailable"
          ]
        },
        "pid": {
          "anyOf": [
            {
              "type": "integer",
              "minimum": -9007199254740991,
              "maximum": 9007199254740991
            },
            {
              "type": "null"
            }
          ]
        },
        "lastHeartbeatAt": {
          "anyOf": [
            {
              "type": "integer",
              "minimum": 0,
              "maximum": 9007199254740991
            },
            {
              "type": "null"
            }
          ]
        },
        "restarts": {
          "type": "integer",
          "minimum": 0,
          "maximum": 9007199254740991
        }
      },
      "required": [
        "state",
        "pid",
        "lastHeartbeatAt",
        "restarts"
      ]
    },
    "db": {
      "type": "object",
      "properties": {
        "schemaVersion": {
          "type": "integer",
          "minimum": 0,
          "maximum": 9007199254740991
        },
        "migrationsPending": {
          "type": "integer",
          "minimum": 0,
          "maximum": 9007199254740991
        },
        "sizeBytes": {
          "type": "integer",
          "minimum": 0,
          "maximum": 9007199254740991
        }
      },
      "required": [
        "schemaVersion",
        "migrationsPending",
        "sizeBytes"
      ]
    },
    "unresolvedAttempts": {
      "type": "integer",
      "minimum": 0,
      "maximum": 9007199254740991
    },
    "secureStorage": {
      "type": "object",
      "properties": {
        "available": {
          "type": "boolean"
        },
        "backend": {
          "type": "string"
        }
      },
      "required": [
        "available",
        "backend"
      ]
    },
    "catalog": {
      "type": "object",
      "properties": {
        "version": {
          "type": [
            "string",
            "null"
          ]
        },
        "models": {
          "type": "integer",
          "minimum": 0,
          "maximum": 9007199254740991
        }
      },
      "required": [
        "version",
        "models"
      ]
    },
    "prompts": {
      "type": "object",
      "properties": {
        "loaded": {
          "type": "integer",
          "minimum": 0,
          "maximum": 9007199254740991
        }
      },
      "required": [
        "loaded"
      ]
    }
  },
  "required": [
    "runner",
    "db",
    "unresolvedAttempts",
    "secureStorage",
    "catalog",
    "prompts"
  ]
}
```

## `app.createBackup`

Channel `relay/v1/app.createBackup` · command · route `runner`

### Input

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "idempotencyKey": {
      "type": "string",
      "minLength": 10,
      "maxLength": 64
    }
  },
  "required": [
    "idempotencyKey"
  ]
}
```

### Output

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "backupDisplayPath": {
      "type": "string"
    },
    "createdAt": {
      "type": "integer",
      "minimum": 0,
      "maximum": 9007199254740991
    },
    "sizeBytes": {
      "type": "integer",
      "minimum": 0,
      "maximum": 9007199254740991
    }
  },
  "required": [
    "backupDisplayPath",
    "createdAt",
    "sizeBytes"
  ]
}
```

## `app.exportDiagnostics`

Channel `relay/v1/app.exportDiagnostics` · command · route `main+runner`

### Input

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "includeRunIds": {
      "maxItems": 50,
      "type": "array",
      "items": {
        "type": "string",
        "pattern": "^run_[0-7][0-9A-HJKMNP-TV-Z]{25}$"
      }
    }
  }
}
```

### Output

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "exported": {
      "type": "boolean"
    },
    "displayPath": {
      "type": "string"
    }
  },
  "required": [
    "exported"
  ]
}
```

## `app.openExternal`

Channel `relay/v1/app.openExternal` · command · route `main`

### Input

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "url": {
      "type": "string",
      "maxLength": 2048,
      "format": "uri"
    }
  },
  "required": [
    "url"
  ]
}
```

### Output

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "opened": {
      "type": "boolean"
    }
  },
  "required": [
    "opened"
  ]
}
```

## `app.getSettings`

Channel `relay/v1/app.getSettings` · query · route `runner`

### Input

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {}
}
```

### Output

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "theme": {
      "type": "string",
      "enum": [
        "system",
        "light",
        "dark"
      ]
    },
    "activeProjectId": {
      "anyOf": [
        {
          "type": "string",
          "pattern": "^prj_[0-7][0-9A-HJKMNP-TV-Z]{25}$"
        },
        {
          "type": "null"
        }
      ]
    },
    "onboardingCompletedAt": {
      "anyOf": [
        {
          "type": "integer",
          "minimum": 0,
          "maximum": 9007199254740991
        },
        {
          "type": "null"
        }
      ]
    },
    "rawResponseRetentionDays": {
      "type": "integer",
      "minimum": 1,
      "maximum": 365
    },
    "setupAllowanceMicrousd": {
      "type": "integer",
      "minimum": 0,
      "maximum": 9007199254740991
    }
  },
  "required": [
    "theme",
    "activeProjectId",
    "onboardingCompletedAt",
    "rawResponseRetentionDays",
    "setupAllowanceMicrousd"
  ]
}
```

## `app.updateSettings`

Channel `relay/v1/app.updateSettings` · command · route `runner`

### Input

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "theme": {
      "type": "string",
      "enum": [
        "system",
        "light",
        "dark"
      ]
    },
    "activeProjectId": {
      "anyOf": [
        {
          "type": "string",
          "pattern": "^prj_[0-7][0-9A-HJKMNP-TV-Z]{25}$"
        },
        {
          "type": "null"
        }
      ]
    },
    "onboardingCompletedAt": {
      "anyOf": [
        {
          "type": "integer",
          "minimum": 0,
          "maximum": 9007199254740991
        },
        {
          "type": "null"
        }
      ]
    },
    "rawResponseRetentionDays": {
      "type": "integer",
      "minimum": 1,
      "maximum": 365
    },
    "setupAllowanceMicrousd": {
      "type": "integer",
      "minimum": 0,
      "maximum": 9007199254740991
    }
  }
}
```

### Output

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "theme": {
      "type": "string",
      "enum": [
        "system",
        "light",
        "dark"
      ]
    },
    "activeProjectId": {
      "anyOf": [
        {
          "type": "string",
          "pattern": "^prj_[0-7][0-9A-HJKMNP-TV-Z]{25}$"
        },
        {
          "type": "null"
        }
      ]
    },
    "onboardingCompletedAt": {
      "anyOf": [
        {
          "type": "integer",
          "minimum": 0,
          "maximum": 9007199254740991
        },
        {
          "type": "null"
        }
      ]
    },
    "rawResponseRetentionDays": {
      "type": "integer",
      "minimum": 1,
      "maximum": 365
    },
    "setupAllowanceMicrousd": {
      "type": "integer",
      "minimum": 0,
      "maximum": 9007199254740991
    }
  },
  "required": [
    "theme",
    "activeProjectId",
    "onboardingCompletedAt",
    "rawResponseRetentionDays",
    "setupAllowanceMicrousd"
  ]
}
```

## `projects.pickDirectory`

Channel `relay/v1/projects.pickDirectory` · command · route `main`

### Input

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {}
}
```

### Output

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "selection": {
      "anyOf": [
        {
          "type": "object",
          "properties": {
            "selectionId": {
              "type": "string",
              "pattern": "^sel_[0-7][0-9A-HJKMNP-TV-Z]{25}$"
            },
            "displayPath": {
              "type": "string"
            },
            "expiresAt": {
              "type": "integer",
              "minimum": 0,
              "maximum": 9007199254740991
            }
          },
          "required": [
            "selectionId",
            "displayPath",
            "expiresAt"
          ]
        },
        {
          "type": "null"
        }
      ]
    }
  },
  "required": [
    "selection"
  ]
}
```

## `projects.previewFiles`

Channel `relay/v1/projects.previewFiles` · query · route `main+runner`

### Input

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "anyOf": [
    {
      "type": "object",
      "properties": {
        "extraExclusions": {
          "maxItems": 100,
          "type": "array",
          "items": {
            "type": "string",
            "maxLength": 200
          }
        },
        "selectionId": {
          "type": "string",
          "pattern": "^sel_[0-7][0-9A-HJKMNP-TV-Z]{25}$"
        }
      },
      "required": [
        "selectionId"
      ]
    },
    {
      "type": "object",
      "properties": {
        "extraExclusions": {
          "maxItems": 100,
          "type": "array",
          "items": {
            "type": "string",
            "maxLength": 200
          }
        },
        "projectId": {
          "type": "string",
          "pattern": "^prj_[0-7][0-9A-HJKMNP-TV-Z]{25}$"
        }
      },
      "required": [
        "projectId"
      ]
    }
  ]
}
```

### Output

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "included": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "relPath": {
            "type": "string",
            "minLength": 1,
            "maxLength": 512
          },
          "sizeBytes": {
            "type": "integer",
            "minimum": 0,
            "maximum": 9007199254740991
          },
          "sha256": {
            "anyOf": [
              {
                "type": "string",
                "pattern": "^[a-f0-9]{64}$"
              },
              {
                "type": "null"
              }
            ]
          }
        },
        "required": [
          "relPath",
          "sizeBytes",
          "sha256"
        ]
      }
    },
    "excluded": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "relPath": {
            "type": "string",
            "minLength": 1,
            "maxLength": 512
          },
          "reason": {
            "type": "string",
            "enum": [
              "dependency_dir",
              "build_output",
              "vcs_internal",
              "secret",
              "os_file",
              "binary",
              "too_large",
              "gitignored",
              "user_pattern",
              "symlink_outside",
              "cap_exceeded"
            ]
          }
        },
        "required": [
          "relPath",
          "reason"
        ]
      }
    },
    "totals": {
      "type": "object",
      "properties": {
        "files": {
          "type": "integer",
          "minimum": -9007199254740991,
          "maximum": 9007199254740991
        },
        "bytes": {
          "type": "integer",
          "minimum": -9007199254740991,
          "maximum": 9007199254740991
        },
        "capBytes": {
          "type": "integer",
          "minimum": -9007199254740991,
          "maximum": 9007199254740991
        },
        "capFiles": {
          "type": "integer",
          "minimum": -9007199254740991,
          "maximum": 9007199254740991
        }
      },
      "required": [
        "files",
        "bytes",
        "capBytes",
        "capFiles"
      ]
    }
  },
  "required": [
    "included",
    "excluded",
    "totals"
  ]
}
```

## `projects.create`

Channel `relay/v1/projects.create` · command · route `main+runner`

### Input

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "idempotencyKey": {
      "type": "string",
      "minLength": 10,
      "maxLength": 64
    },
    "selectionId": {
      "type": "string",
      "pattern": "^sel_[0-7][0-9A-HJKMNP-TV-Z]{25}$"
    },
    "name": {
      "type": "string",
      "minLength": 1,
      "maxLength": 80
    },
    "exclusions": {
      "maxItems": 100,
      "type": "array",
      "items": {
        "type": "string",
        "maxLength": 200
      }
    },
    "allowedProviderIds": {
      "type": "array",
      "items": {
        "type": "string",
        "enum": [
          "anthropic",
          "openai",
          "gemini",
          "fake"
        ]
      }
    },
    "monthlyAllowanceMicrousd": {
      "anyOf": [
        {
          "type": "integer",
          "minimum": 0,
          "maximum": 9007199254740991
        },
        {
          "type": "null"
        }
      ]
    }
  },
  "required": [
    "idempotencyKey",
    "selectionId",
    "name",
    "allowedProviderIds"
  ]
}
```

### Output

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "id": {
      "type": "string",
      "pattern": "^prj_[0-7][0-9A-HJKMNP-TV-Z]{25}$"
    },
    "name": {
      "type": "string",
      "minLength": 1,
      "maxLength": 80
    },
    "rootDisplayPath": {
      "type": "string"
    },
    "exclusions": {
      "maxItems": 100,
      "type": "array",
      "items": {
        "type": "string",
        "maxLength": 200
      }
    },
    "providerPolicy": {
      "type": "object",
      "properties": {
        "allowedProviderIds": {
          "type": "array",
          "items": {
            "type": "string",
            "enum": [
              "anthropic",
              "openai",
              "gemini",
              "fake"
            ]
          }
        },
        "providerOptions": {
          "default": {},
          "type": "object",
          "properties": {
            "openai": {
              "default": {},
              "type": "object",
              "properties": {
                "storeResponses": {
                  "default": true,
                  "type": "boolean"
                }
              }
            }
          }
        }
      },
      "required": [
        "allowedProviderIds"
      ]
    },
    "monthlyAllowanceMicrousd": {
      "anyOf": [
        {
          "type": "integer",
          "minimum": 0,
          "maximum": 9007199254740991
        },
        {
          "type": "null"
        }
      ]
    },
    "isDemo": {
      "type": "boolean"
    },
    "createdAt": {
      "type": "integer",
      "minimum": 0,
      "maximum": 9007199254740991
    },
    "updatedAt": {
      "type": "integer",
      "minimum": 0,
      "maximum": 9007199254740991
    },
    "archivedAt": {
      "anyOf": [
        {
          "type": "integer",
          "minimum": 0,
          "maximum": 9007199254740991
        },
        {
          "type": "null"
        }
      ]
    }
  },
  "required": [
    "id",
    "name",
    "rootDisplayPath",
    "exclusions",
    "providerPolicy",
    "monthlyAllowanceMicrousd",
    "isDemo",
    "createdAt",
    "updatedAt",
    "archivedAt"
  ]
}
```

## `projects.list`

Channel `relay/v1/projects.list` · query · route `runner`

### Input

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "includeArchived": {
      "type": "boolean"
    }
  }
}
```

### Output

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "array",
  "items": {
    "type": "object",
    "properties": {
      "id": {
        "type": "string",
        "pattern": "^prj_[0-7][0-9A-HJKMNP-TV-Z]{25}$"
      },
      "name": {
        "type": "string",
        "minLength": 1,
        "maxLength": 80
      },
      "rootDisplayPath": {
        "type": "string"
      },
      "exclusions": {
        "maxItems": 100,
        "type": "array",
        "items": {
          "type": "string",
          "maxLength": 200
        }
      },
      "providerPolicy": {
        "type": "object",
        "properties": {
          "allowedProviderIds": {
            "type": "array",
            "items": {
              "type": "string",
              "enum": [
                "anthropic",
                "openai",
                "gemini",
                "fake"
              ]
            }
          },
          "providerOptions": {
            "default": {},
            "type": "object",
            "properties": {
              "openai": {
                "default": {},
                "type": "object",
                "properties": {
                  "storeResponses": {
                    "default": true,
                    "type": "boolean"
                  }
                }
              }
            }
          }
        },
        "required": [
          "allowedProviderIds"
        ]
      },
      "monthlyAllowanceMicrousd": {
        "anyOf": [
          {
            "type": "integer",
            "minimum": 0,
            "maximum": 9007199254740991
          },
          {
            "type": "null"
          }
        ]
      },
      "isDemo": {
        "type": "boolean"
      },
      "createdAt": {
        "type": "integer",
        "minimum": 0,
        "maximum": 9007199254740991
      },
      "updatedAt": {
        "type": "integer",
        "minimum": 0,
        "maximum": 9007199254740991
      },
      "archivedAt": {
        "anyOf": [
          {
            "type": "integer",
            "minimum": 0,
            "maximum": 9007199254740991
          },
          {
            "type": "null"
          }
        ]
      }
    },
    "required": [
      "id",
      "name",
      "rootDisplayPath",
      "exclusions",
      "providerPolicy",
      "monthlyAllowanceMicrousd",
      "isDemo",
      "createdAt",
      "updatedAt",
      "archivedAt"
    ]
  }
}
```

## `projects.get`

Channel `relay/v1/projects.get` · query · route `runner`

### Input

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "projectId": {
      "type": "string",
      "pattern": "^prj_[0-7][0-9A-HJKMNP-TV-Z]{25}$"
    }
  },
  "required": [
    "projectId"
  ]
}
```

### Output

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "id": {
      "type": "string",
      "pattern": "^prj_[0-7][0-9A-HJKMNP-TV-Z]{25}$"
    },
    "name": {
      "type": "string",
      "minLength": 1,
      "maxLength": 80
    },
    "rootDisplayPath": {
      "type": "string"
    },
    "exclusions": {
      "maxItems": 100,
      "type": "array",
      "items": {
        "type": "string",
        "maxLength": 200
      }
    },
    "providerPolicy": {
      "type": "object",
      "properties": {
        "allowedProviderIds": {
          "type": "array",
          "items": {
            "type": "string",
            "enum": [
              "anthropic",
              "openai",
              "gemini",
              "fake"
            ]
          }
        },
        "providerOptions": {
          "default": {},
          "type": "object",
          "properties": {
            "openai": {
              "default": {},
              "type": "object",
              "properties": {
                "storeResponses": {
                  "default": true,
                  "type": "boolean"
                }
              }
            }
          }
        }
      },
      "required": [
        "allowedProviderIds"
      ]
    },
    "monthlyAllowanceMicrousd": {
      "anyOf": [
        {
          "type": "integer",
          "minimum": 0,
          "maximum": 9007199254740991
        },
        {
          "type": "null"
        }
      ]
    },
    "isDemo": {
      "type": "boolean"
    },
    "createdAt": {
      "type": "integer",
      "minimum": 0,
      "maximum": 9007199254740991
    },
    "updatedAt": {
      "type": "integer",
      "minimum": 0,
      "maximum": 9007199254740991
    },
    "archivedAt": {
      "anyOf": [
        {
          "type": "integer",
          "minimum": 0,
          "maximum": 9007199254740991
        },
        {
          "type": "null"
        }
      ]
    },
    "stats": {
      "type": "object",
      "properties": {
        "runs": {
          "type": "integer",
          "minimum": 0,
          "maximum": 9007199254740991
        },
        "activeRunId": {
          "anyOf": [
            {
              "type": "string",
              "pattern": "^run_[0-7][0-9A-HJKMNP-TV-Z]{25}$"
            },
            {
              "type": "null"
            }
          ]
        },
        "approvedMemory": {
          "type": "integer",
          "minimum": 0,
          "maximum": 9007199254740991
        },
        "suggestions": {
          "type": "integer",
          "minimum": 0,
          "maximum": 9007199254740991
        },
        "trackedMonthMicrousd": {
          "type": "integer",
          "minimum": -9007199254740991,
          "maximum": 9007199254740991
        }
      },
      "required": [
        "runs",
        "activeRunId",
        "approvedMemory",
        "suggestions",
        "trackedMonthMicrousd"
      ]
    }
  },
  "required": [
    "id",
    "name",
    "rootDisplayPath",
    "exclusions",
    "providerPolicy",
    "monthlyAllowanceMicrousd",
    "isDemo",
    "createdAt",
    "updatedAt",
    "archivedAt",
    "stats"
  ]
}
```

## `projects.update`

Channel `relay/v1/projects.update` · command · route `runner`

### Input

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "projectId": {
      "type": "string",
      "pattern": "^prj_[0-7][0-9A-HJKMNP-TV-Z]{25}$"
    },
    "expectedUpdatedAt": {
      "type": "integer",
      "minimum": 0,
      "maximum": 9007199254740991
    },
    "patch": {
      "type": "object",
      "properties": {
        "name": {
          "type": "string",
          "minLength": 1,
          "maxLength": 80
        },
        "exclusions": {
          "maxItems": 100,
          "type": "array",
          "items": {
            "type": "string",
            "maxLength": 200
          }
        },
        "allowedProviderIds": {
          "type": "array",
          "items": {
            "type": "string",
            "enum": [
              "anthropic",
              "openai",
              "gemini",
              "fake"
            ]
          }
        },
        "providerOptions": {
          "type": "object",
          "properties": {
            "openai": {
              "default": {},
              "type": "object",
              "properties": {
                "storeResponses": {
                  "default": true,
                  "type": "boolean"
                }
              }
            }
          }
        },
        "monthlyAllowanceMicrousd": {
          "anyOf": [
            {
              "type": "integer",
              "minimum": 0,
              "maximum": 9007199254740991
            },
            {
              "type": "null"
            }
          ]
        }
      }
    }
  },
  "required": [
    "projectId",
    "expectedUpdatedAt",
    "patch"
  ]
}
```

### Output

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "id": {
      "type": "string",
      "pattern": "^prj_[0-7][0-9A-HJKMNP-TV-Z]{25}$"
    },
    "name": {
      "type": "string",
      "minLength": 1,
      "maxLength": 80
    },
    "rootDisplayPath": {
      "type": "string"
    },
    "exclusions": {
      "maxItems": 100,
      "type": "array",
      "items": {
        "type": "string",
        "maxLength": 200
      }
    },
    "providerPolicy": {
      "type": "object",
      "properties": {
        "allowedProviderIds": {
          "type": "array",
          "items": {
            "type": "string",
            "enum": [
              "anthropic",
              "openai",
              "gemini",
              "fake"
            ]
          }
        },
        "providerOptions": {
          "default": {},
          "type": "object",
          "properties": {
            "openai": {
              "default": {},
              "type": "object",
              "properties": {
                "storeResponses": {
                  "default": true,
                  "type": "boolean"
                }
              }
            }
          }
        }
      },
      "required": [
        "allowedProviderIds"
      ]
    },
    "monthlyAllowanceMicrousd": {
      "anyOf": [
        {
          "type": "integer",
          "minimum": 0,
          "maximum": 9007199254740991
        },
        {
          "type": "null"
        }
      ]
    },
    "isDemo": {
      "type": "boolean"
    },
    "createdAt": {
      "type": "integer",
      "minimum": 0,
      "maximum": 9007199254740991
    },
    "updatedAt": {
      "type": "integer",
      "minimum": 0,
      "maximum": 9007199254740991
    },
    "archivedAt": {
      "anyOf": [
        {
          "type": "integer",
          "minimum": 0,
          "maximum": 9007199254740991
        },
        {
          "type": "null"
        }
      ]
    }
  },
  "required": [
    "id",
    "name",
    "rootDisplayPath",
    "exclusions",
    "providerPolicy",
    "monthlyAllowanceMicrousd",
    "isDemo",
    "createdAt",
    "updatedAt",
    "archivedAt"
  ]
}
```

## `projects.archive`

Channel `relay/v1/projects.archive` · command · route `runner`

### Input

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "projectId": {
      "type": "string",
      "pattern": "^prj_[0-7][0-9A-HJKMNP-TV-Z]{25}$"
    }
  },
  "required": [
    "projectId"
  ]
}
```

### Output

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "id": {
      "type": "string",
      "pattern": "^prj_[0-7][0-9A-HJKMNP-TV-Z]{25}$"
    },
    "name": {
      "type": "string",
      "minLength": 1,
      "maxLength": 80
    },
    "rootDisplayPath": {
      "type": "string"
    },
    "exclusions": {
      "maxItems": 100,
      "type": "array",
      "items": {
        "type": "string",
        "maxLength": 200
      }
    },
    "providerPolicy": {
      "type": "object",
      "properties": {
        "allowedProviderIds": {
          "type": "array",
          "items": {
            "type": "string",
            "enum": [
              "anthropic",
              "openai",
              "gemini",
              "fake"
            ]
          }
        },
        "providerOptions": {
          "default": {},
          "type": "object",
          "properties": {
            "openai": {
              "default": {},
              "type": "object",
              "properties": {
                "storeResponses": {
                  "default": true,
                  "type": "boolean"
                }
              }
            }
          }
        }
      },
      "required": [
        "allowedProviderIds"
      ]
    },
    "monthlyAllowanceMicrousd": {
      "anyOf": [
        {
          "type": "integer",
          "minimum": 0,
          "maximum": 9007199254740991
        },
        {
          "type": "null"
        }
      ]
    },
    "isDemo": {
      "type": "boolean"
    },
    "createdAt": {
      "type": "integer",
      "minimum": 0,
      "maximum": 9007199254740991
    },
    "updatedAt": {
      "type": "integer",
      "minimum": 0,
      "maximum": 9007199254740991
    },
    "archivedAt": {
      "anyOf": [
        {
          "type": "integer",
          "minimum": 0,
          "maximum": 9007199254740991
        },
        {
          "type": "null"
        }
      ]
    }
  },
  "required": [
    "id",
    "name",
    "rootDisplayPath",
    "exclusions",
    "providerPolicy",
    "monthlyAllowanceMicrousd",
    "isDemo",
    "createdAt",
    "updatedAt",
    "archivedAt"
  ]
}
```

## `projects.export`

Channel `relay/v1/projects.export` · command · route `main+runner`

### Input

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "projectId": {
      "type": "string",
      "pattern": "^prj_[0-7][0-9A-HJKMNP-TV-Z]{25}$"
    },
    "runIds": {
      "type": "array",
      "items": {
        "type": "string",
        "pattern": "^run_[0-7][0-9A-HJKMNP-TV-Z]{25}$"
      }
    }
  },
  "required": [
    "projectId"
  ]
}
```

### Output

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "exported": {
      "type": "boolean"
    },
    "displayPath": {
      "type": "string"
    }
  },
  "required": [
    "exported"
  ]
}
```

## `projects.createSample`

Channel `relay/v1/projects.createSample` · command · route `main+runner`

### Input

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "idempotencyKey": {
      "type": "string",
      "minLength": 10,
      "maxLength": 64
    }
  },
  "required": [
    "idempotencyKey"
  ]
}
```

### Output

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "id": {
      "type": "string",
      "pattern": "^prj_[0-7][0-9A-HJKMNP-TV-Z]{25}$"
    },
    "name": {
      "type": "string",
      "minLength": 1,
      "maxLength": 80
    },
    "rootDisplayPath": {
      "type": "string"
    },
    "exclusions": {
      "maxItems": 100,
      "type": "array",
      "items": {
        "type": "string",
        "maxLength": 200
      }
    },
    "providerPolicy": {
      "type": "object",
      "properties": {
        "allowedProviderIds": {
          "type": "array",
          "items": {
            "type": "string",
            "enum": [
              "anthropic",
              "openai",
              "gemini",
              "fake"
            ]
          }
        },
        "providerOptions": {
          "default": {},
          "type": "object",
          "properties": {
            "openai": {
              "default": {},
              "type": "object",
              "properties": {
                "storeResponses": {
                  "default": true,
                  "type": "boolean"
                }
              }
            }
          }
        }
      },
      "required": [
        "allowedProviderIds"
      ]
    },
    "monthlyAllowanceMicrousd": {
      "anyOf": [
        {
          "type": "integer",
          "minimum": 0,
          "maximum": 9007199254740991
        },
        {
          "type": "null"
        }
      ]
    },
    "isDemo": {
      "type": "boolean"
    },
    "createdAt": {
      "type": "integer",
      "minimum": 0,
      "maximum": 9007199254740991
    },
    "updatedAt": {
      "type": "integer",
      "minimum": 0,
      "maximum": 9007199254740991
    },
    "archivedAt": {
      "anyOf": [
        {
          "type": "integer",
          "minimum": 0,
          "maximum": 9007199254740991
        },
        {
          "type": "null"
        }
      ]
    }
  },
  "required": [
    "id",
    "name",
    "rootDisplayPath",
    "exclusions",
    "providerPolicy",
    "monthlyAllowanceMicrousd",
    "isDemo",
    "createdAt",
    "updatedAt",
    "archivedAt"
  ]
}
```

## `providers.list`

Channel `relay/v1/providers.list` · query · route `main+runner`

### Input

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {}
}
```

### Output

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "array",
  "items": {
    "type": "object",
    "properties": {
      "providerId": {
        "type": "string",
        "enum": [
          "anthropic",
          "openai",
          "gemini",
          "fake"
        ]
      },
      "displayName": {
        "type": "string"
      },
      "connected": {
        "type": "boolean"
      },
      "storage": {
        "type": "string",
        "enum": [
          "os_protected",
          "session",
          "none"
        ]
      },
      "redactedLabel": {
        "anyOf": [
          {
            "type": "string",
            "maxLength": 40
          },
          {
            "type": "null"
          }
        ]
      },
      "lastTest": {
        "anyOf": [
          {
            "type": "object",
            "properties": {
              "at": {
                "type": "integer",
                "minimum": 0,
                "maximum": 9007199254740991
              },
              "ok": {
                "type": "boolean"
              },
              "code": {
                "type": "string",
                "enum": [
                  "AUTH_REQUIRED",
                  "MODEL_UNSUPPORTED",
                  "RATE_LIMITED",
                  "BUDGET_BLOCKED",
                  "CONTEXT_TOO_LARGE",
                  "OUTPUT_INVALID",
                  "APPROVAL_STALE",
                  "PROJECT_CHANGED",
                  "REQUEST_OUTCOME_UNKNOWN",
                  "ARTIFACT_WRITE_FAILED",
                  "RUNNER_UNAVAILABLE",
                  "PROVIDER_UNAVAILABLE",
                  "VALIDATION_FAILED",
                  "NOT_FOUND",
                  "CONFLICT",
                  "LIMIT_REACHED",
                  "PERMISSION_DENIED",
                  "SECURE_STORAGE_UNAVAILABLE",
                  "MODEL_REFUSED",
                  "INTERNAL"
                ]
              }
            },
            "required": [
              "at",
              "ok"
            ]
          },
          {
            "type": "null"
          }
        ]
      }
    },
    "required": [
      "providerId",
      "displayName",
      "connected",
      "storage",
      "redactedLabel",
      "lastTest"
    ]
  }
}
```

## `providers.connect`

Channel `relay/v1/providers.connect` · command · route `main+runner`

### Input

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "providerId": {
      "type": "string",
      "enum": [
        "anthropic",
        "openai",
        "gemini",
        "fake"
      ]
    },
    "apiKey": {
      "type": "string",
      "minLength": 20,
      "maxLength": 400
    },
    "storage": {
      "type": "string",
      "enum": [
        "os_protected",
        "session"
      ]
    }
  },
  "required": [
    "providerId",
    "apiKey",
    "storage"
  ]
}
```

### Output

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "providerId": {
      "type": "string",
      "enum": [
        "anthropic",
        "openai",
        "gemini",
        "fake"
      ]
    },
    "displayName": {
      "type": "string"
    },
    "connected": {
      "type": "boolean"
    },
    "storage": {
      "type": "string",
      "enum": [
        "os_protected",
        "session",
        "none"
      ]
    },
    "redactedLabel": {
      "anyOf": [
        {
          "type": "string",
          "maxLength": 40
        },
        {
          "type": "null"
        }
      ]
    },
    "lastTest": {
      "anyOf": [
        {
          "type": "object",
          "properties": {
            "at": {
              "type": "integer",
              "minimum": 0,
              "maximum": 9007199254740991
            },
            "ok": {
              "type": "boolean"
            },
            "code": {
              "type": "string",
              "enum": [
                "AUTH_REQUIRED",
                "MODEL_UNSUPPORTED",
                "RATE_LIMITED",
                "BUDGET_BLOCKED",
                "CONTEXT_TOO_LARGE",
                "OUTPUT_INVALID",
                "APPROVAL_STALE",
                "PROJECT_CHANGED",
                "REQUEST_OUTCOME_UNKNOWN",
                "ARTIFACT_WRITE_FAILED",
                "RUNNER_UNAVAILABLE",
                "PROVIDER_UNAVAILABLE",
                "VALIDATION_FAILED",
                "NOT_FOUND",
                "CONFLICT",
                "LIMIT_REACHED",
                "PERMISSION_DENIED",
                "SECURE_STORAGE_UNAVAILABLE",
                "MODEL_REFUSED",
                "INTERNAL"
              ]
            }
          },
          "required": [
            "at",
            "ok"
          ]
        },
        {
          "type": "null"
        }
      ]
    }
  },
  "required": [
    "providerId",
    "displayName",
    "connected",
    "storage",
    "redactedLabel",
    "lastTest"
  ]
}
```

## `providers.test`

Channel `relay/v1/providers.test` · command · route `main+runner`

### Input

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "providerId": {
      "type": "string",
      "enum": [
        "anthropic",
        "openai",
        "gemini",
        "fake"
      ]
    }
  },
  "required": [
    "providerId"
  ]
}
```

### Output

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "ok": {
      "type": "boolean"
    },
    "latencyMs": {
      "type": "integer",
      "minimum": 0,
      "maximum": 9007199254740991
    },
    "modelProbed": {
      "type": "string"
    },
    "error": {
      "type": "object",
      "properties": {
        "code": {
          "type": "string",
          "enum": [
            "AUTH_REQUIRED",
            "MODEL_UNSUPPORTED",
            "RATE_LIMITED",
            "BUDGET_BLOCKED",
            "CONTEXT_TOO_LARGE",
            "OUTPUT_INVALID",
            "APPROVAL_STALE",
            "PROJECT_CHANGED",
            "REQUEST_OUTCOME_UNKNOWN",
            "ARTIFACT_WRITE_FAILED",
            "RUNNER_UNAVAILABLE",
            "PROVIDER_UNAVAILABLE",
            "VALIDATION_FAILED",
            "NOT_FOUND",
            "CONFLICT",
            "LIMIT_REACHED",
            "PERMISSION_DENIED",
            "SECURE_STORAGE_UNAVAILABLE",
            "MODEL_REFUSED",
            "INTERNAL"
          ]
        },
        "userMessage": {
          "type": "string",
          "maxLength": 400
        },
        "retryable": {
          "type": "boolean"
        },
        "nextAction": {
          "type": "string",
          "enum": [
            "reconnect_provider",
            "choose_profile",
            "wait",
            "increase_allowance",
            "stop",
            "narrow_scope",
            "retry_step",
            "reapprove",
            "resnapshot_and_replan",
            "use_preserved_snapshot",
            "decide_unknown",
            "retry_export",
            "restart_runner",
            "fix_input",
            "none",
            "reload",
            "raise_limits",
            "edit_policy",
            "use_session_key",
            "edit_goal",
            "report_bug"
          ]
        },
        "alternatives": {
          "default": [],
          "type": "array",
          "items": {
            "type": "string",
            "enum": [
              "reconnect_provider",
              "choose_profile",
              "wait",
              "increase_allowance",
              "stop",
              "narrow_scope",
              "retry_step",
              "reapprove",
              "resnapshot_and_replan",
              "use_preserved_snapshot",
              "decide_unknown",
              "retry_export",
              "restart_runner",
              "fix_input",
              "none",
              "reload",
              "raise_limits",
              "edit_policy",
              "use_session_key",
              "edit_goal",
              "report_bug"
            ]
          }
        },
        "attemptId": {
          "type": "string",
          "pattern": "^att_[0-7][0-9A-HJKMNP-TV-Z]{25}$"
        },
        "runId": {
          "type": "string",
          "pattern": "^run_[0-7][0-9A-HJKMNP-TV-Z]{25}$"
        },
        "details": {
          "type": "object",
          "propertyNames": {
            "type": "string"
          },
          "additionalProperties": {}
        },
        "correlationId": {
          "type": "string",
          "pattern": "^cor_[0-7][0-9A-HJKMNP-TV-Z]{25}$"
        }
      },
      "required": [
        "code",
        "userMessage",
        "retryable",
        "nextAction"
      ]
    },
    "costMicrousd": {
      "type": "integer",
      "minimum": -9007199254740991,
      "maximum": 9007199254740991
    },
    "certainty": {
      "type": "string",
      "enum": [
        "reported",
        "calculated",
        "estimated",
        "unknown"
      ]
    }
  },
  "required": [
    "ok",
    "latencyMs",
    "modelProbed",
    "costMicrousd",
    "certainty"
  ]
}
```

## `providers.disconnect`

Channel `relay/v1/providers.disconnect` · command · route `main+runner`

### Input

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "providerId": {
      "type": "string",
      "enum": [
        "anthropic",
        "openai",
        "gemini",
        "fake"
      ]
    }
  },
  "required": [
    "providerId"
  ]
}
```

### Output

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "providerId": {
      "type": "string",
      "enum": [
        "anthropic",
        "openai",
        "gemini",
        "fake"
      ]
    },
    "displayName": {
      "type": "string"
    },
    "connected": {
      "type": "boolean"
    },
    "storage": {
      "type": "string",
      "enum": [
        "os_protected",
        "session",
        "none"
      ]
    },
    "redactedLabel": {
      "anyOf": [
        {
          "type": "string",
          "maxLength": 40
        },
        {
          "type": "null"
        }
      ]
    },
    "lastTest": {
      "anyOf": [
        {
          "type": "object",
          "properties": {
            "at": {
              "type": "integer",
              "minimum": 0,
              "maximum": 9007199254740991
            },
            "ok": {
              "type": "boolean"
            },
            "code": {
              "type": "string",
              "enum": [
                "AUTH_REQUIRED",
                "MODEL_UNSUPPORTED",
                "RATE_LIMITED",
                "BUDGET_BLOCKED",
                "CONTEXT_TOO_LARGE",
                "OUTPUT_INVALID",
                "APPROVAL_STALE",
                "PROJECT_CHANGED",
                "REQUEST_OUTCOME_UNKNOWN",
                "ARTIFACT_WRITE_FAILED",
                "RUNNER_UNAVAILABLE",
                "PROVIDER_UNAVAILABLE",
                "VALIDATION_FAILED",
                "NOT_FOUND",
                "CONFLICT",
                "LIMIT_REACHED",
                "PERMISSION_DENIED",
                "SECURE_STORAGE_UNAVAILABLE",
                "MODEL_REFUSED",
                "INTERNAL"
              ]
            }
          },
          "required": [
            "at",
            "ok"
          ]
        },
        {
          "type": "null"
        }
      ]
    }
  },
  "required": [
    "providerId",
    "displayName",
    "connected",
    "storage",
    "redactedLabel",
    "lastTest"
  ]
}
```

## `providers.catalog`

Channel `relay/v1/providers.catalog` · query · route `runner`

### Input

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "providerId": {
      "type": "string",
      "enum": [
        "anthropic",
        "openai",
        "gemini",
        "fake"
      ]
    }
  }
}
```

### Output

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "array",
  "items": {
    "type": "object",
    "properties": {
      "providerId": {
        "type": "string",
        "enum": [
          "anthropic",
          "openai",
          "gemini",
          "fake"
        ]
      },
      "modelId": {
        "type": "string",
        "minLength": 1,
        "maxLength": 120
      },
      "displayName": {
        "type": "string",
        "minLength": 1,
        "maxLength": 80
      },
      "capabilities": {
        "type": "object",
        "properties": {
          "structuredOutput": {
            "type": "boolean"
          },
          "streaming": {
            "type": "boolean"
          },
          "tools": {
            "type": "boolean"
          },
          "maxInputTokens": {
            "type": "integer",
            "exclusiveMinimum": 0,
            "maximum": 9007199254740991
          },
          "priceCliffInputTokens": {
            "type": "integer",
            "exclusiveMinimum": 0,
            "maximum": 9007199254740991
          },
          "maxOutputTokens": {
            "type": "integer",
            "exclusiveMinimum": 0,
            "maximum": 9007199254740991
          },
          "supportsRequestLookup": {
            "type": "boolean"
          },
          "supportsTokenCounting": {
            "type": "boolean"
          },
          "effortLevels": {
            "type": "array",
            "items": {
              "type": "string",
              "enum": [
                "low",
                "medium",
                "high",
                "xhigh",
                "max"
              ]
            }
          },
          "thinkingAlwaysOn": {
            "type": "boolean"
          }
        },
        "required": [
          "structuredOutput",
          "streaming",
          "tools",
          "supportsRequestLookup",
          "supportsTokenCounting",
          "effortLevels",
          "thinkingAlwaysOn"
        ]
      },
      "prices": {
        "type": "object",
        "properties": {
          "input": {
            "type": "integer",
            "minimum": 0,
            "maximum": 9007199254740991
          },
          "output": {
            "type": "integer",
            "minimum": 0,
            "maximum": 9007199254740991
          },
          "cacheRead": {
            "type": "integer",
            "minimum": 0,
            "maximum": 9007199254740991
          },
          "cacheWrite": {
            "type": "integer",
            "minimum": 0,
            "maximum": 9007199254740991
          }
        },
        "required": [
          "input",
          "output",
          "cacheRead",
          "cacheWrite"
        ]
      },
      "effectiveDate": {
        "type": "string",
        "pattern": "^\\d{4}-\\d{2}-\\d{2}$"
      },
      "source": {
        "type": "string",
        "pattern": "^https:\\/\\/"
      },
      "sourceRetrievedAt": {
        "type": "string",
        "pattern": "^\\d{4}-\\d{2}-\\d{2}$"
      },
      "catalogVersion": {
        "type": "string"
      }
    },
    "required": [
      "providerId",
      "modelId",
      "displayName",
      "capabilities",
      "prices",
      "effectiveDate",
      "source",
      "sourceRetrievedAt",
      "catalogVersion"
    ]
  }
}
```

## `profiles.list`

Channel `relay/v1/profiles.list` · query · route `runner`

### Input

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {}
}
```

### Output

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "array",
  "items": {
    "type": "object",
    "properties": {
      "profile": {
        "type": "object",
        "properties": {
          "id": {
            "type": "string",
            "pattern": "^prf_[0-7][0-9A-HJKMNP-TV-Z]{25}$"
          },
          "name": {
            "type": "string",
            "minLength": 1,
            "maxLength": 40
          },
          "providerId": {
            "type": "string",
            "enum": [
              "anthropic",
              "openai",
              "gemini",
              "fake"
            ]
          },
          "modelId": {
            "type": "string",
            "minLength": 1,
            "maxLength": 120
          },
          "params": {
            "type": "object",
            "properties": {
              "maxOutputTokens": {
                "type": "integer",
                "exclusiveMinimum": 0,
                "maximum": 128000
              },
              "maxInputTokens": {
                "type": "integer",
                "exclusiveMinimum": 0,
                "maximum": 9007199254740991
              },
              "effort": {
                "type": "string",
                "enum": [
                  "low",
                  "medium",
                  "high",
                  "xhigh",
                  "max"
                ]
              },
              "refusalFallback": {
                "default": "off",
                "type": "string",
                "enum": [
                  "off",
                  "default"
                ]
              }
            },
            "required": [
              "maxOutputTokens"
            ]
          },
          "revision": {
            "type": "integer",
            "exclusiveMinimum": 0,
            "maximum": 9007199254740991
          },
          "updatedAt": {
            "type": "integer",
            "minimum": 0,
            "maximum": 9007199254740991
          }
        },
        "required": [
          "id",
          "name",
          "providerId",
          "modelId",
          "params",
          "revision",
          "updatedAt"
        ]
      },
      "warnings": {
        "type": "array",
        "items": {
          "type": "object",
          "properties": {
            "stepKey": {
              "anyOf": [
                {
                  "type": "string",
                  "pattern": "^[a-z][a-z0-9_-]{0,31}$"
                },
                {
                  "type": "null"
                }
              ]
            },
            "profileId": {
              "anyOf": [
                {
                  "type": "string",
                  "pattern": "^prf_[0-7][0-9A-HJKMNP-TV-Z]{25}$"
                },
                {
                  "type": "null"
                }
              ]
            },
            "code": {
              "type": "string",
              "enum": [
                "structured_output_unsupported",
                "effort_unsupported",
                "output_budget_low",
                "input_budget_low",
                "missing_credential",
                "provider_not_allowed",
                "model_unknown"
              ]
            },
            "message": {
              "type": "string",
              "maxLength": 400
            }
          },
          "required": [
            "stepKey",
            "profileId",
            "code",
            "message"
          ]
        }
      }
    },
    "required": [
      "profile",
      "warnings"
    ]
  }
}
```

## `profiles.upsert`

Channel `relay/v1/profiles.upsert` · command · route `runner`

### Input

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "profile": {
      "type": "object",
      "properties": {
        "name": {
          "type": "string",
          "minLength": 1,
          "maxLength": 40
        },
        "providerId": {
          "type": "string",
          "enum": [
            "anthropic",
            "openai",
            "gemini",
            "fake"
          ]
        },
        "modelId": {
          "type": "string",
          "minLength": 1,
          "maxLength": 120
        },
        "params": {
          "type": "object",
          "properties": {
            "maxOutputTokens": {
              "type": "integer",
              "exclusiveMinimum": 0,
              "maximum": 128000
            },
            "maxInputTokens": {
              "type": "integer",
              "exclusiveMinimum": 0,
              "maximum": 9007199254740991
            },
            "effort": {
              "type": "string",
              "enum": [
                "low",
                "medium",
                "high",
                "xhigh",
                "max"
              ]
            },
            "refusalFallback": {
              "default": "off",
              "type": "string",
              "enum": [
                "off",
                "default"
              ]
            }
          },
          "required": [
            "maxOutputTokens"
          ]
        },
        "id": {
          "type": "string",
          "pattern": "^prf_[0-7][0-9A-HJKMNP-TV-Z]{25}$"
        }
      },
      "required": [
        "name",
        "providerId",
        "modelId",
        "params"
      ]
    },
    "expectedRevision": {
      "type": "integer",
      "exclusiveMinimum": 0,
      "maximum": 9007199254740991
    }
  },
  "required": [
    "profile"
  ]
}
```

### Output

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "profile": {
      "type": "object",
      "properties": {
        "id": {
          "type": "string",
          "pattern": "^prf_[0-7][0-9A-HJKMNP-TV-Z]{25}$"
        },
        "name": {
          "type": "string",
          "minLength": 1,
          "maxLength": 40
        },
        "providerId": {
          "type": "string",
          "enum": [
            "anthropic",
            "openai",
            "gemini",
            "fake"
          ]
        },
        "modelId": {
          "type": "string",
          "minLength": 1,
          "maxLength": 120
        },
        "params": {
          "type": "object",
          "properties": {
            "maxOutputTokens": {
              "type": "integer",
              "exclusiveMinimum": 0,
              "maximum": 128000
            },
            "maxInputTokens": {
              "type": "integer",
              "exclusiveMinimum": 0,
              "maximum": 9007199254740991
            },
            "effort": {
              "type": "string",
              "enum": [
                "low",
                "medium",
                "high",
                "xhigh",
                "max"
              ]
            },
            "refusalFallback": {
              "default": "off",
              "type": "string",
              "enum": [
                "off",
                "default"
              ]
            }
          },
          "required": [
            "maxOutputTokens"
          ]
        },
        "revision": {
          "type": "integer",
          "exclusiveMinimum": 0,
          "maximum": 9007199254740991
        },
        "updatedAt": {
          "type": "integer",
          "minimum": 0,
          "maximum": 9007199254740991
        }
      },
      "required": [
        "id",
        "name",
        "providerId",
        "modelId",
        "params",
        "revision",
        "updatedAt"
      ]
    },
    "warnings": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "stepKey": {
            "anyOf": [
              {
                "type": "string",
                "pattern": "^[a-z][a-z0-9_-]{0,31}$"
              },
              {
                "type": "null"
              }
            ]
          },
          "profileId": {
            "anyOf": [
              {
                "type": "string",
                "pattern": "^prf_[0-7][0-9A-HJKMNP-TV-Z]{25}$"
              },
              {
                "type": "null"
              }
            ]
          },
          "code": {
            "type": "string",
            "enum": [
              "structured_output_unsupported",
              "effort_unsupported",
              "output_budget_low",
              "input_budget_low",
              "missing_credential",
              "provider_not_allowed",
              "model_unknown"
            ]
          },
          "message": {
            "type": "string",
            "maxLength": 400
          }
        },
        "required": [
          "stepKey",
          "profileId",
          "code",
          "message"
        ]
      }
    }
  },
  "required": [
    "profile",
    "warnings"
  ]
}
```

## `profiles.delete`

Channel `relay/v1/profiles.delete` · command · route `runner`

### Input

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "profileId": {
      "type": "string",
      "pattern": "^prf_[0-7][0-9A-HJKMNP-TV-Z]{25}$"
    }
  },
  "required": [
    "profileId"
  ]
}
```

### Output

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "deleted": {
      "type": "boolean",
      "const": true
    }
  },
  "required": [
    "deleted"
  ]
}
```

## `workflows.list`

Channel `relay/v1/workflows.list` · query · route `runner`

### Input

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {}
}
```

### Output

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "array",
  "items": {
    "type": "object",
    "properties": {
      "id": {
        "type": "string",
        "pattern": "^wfl_[0-7][0-9A-HJKMNP-TV-Z]{25}$"
      },
      "name": {
        "type": "string"
      },
      "latestValidatedVersion": {
        "anyOf": [
          {
            "type": "integer",
            "minimum": -9007199254740991,
            "maximum": 9007199254740991
          },
          {
            "type": "null"
          }
        ]
      },
      "draftVersion": {
        "anyOf": [
          {
            "type": "integer",
            "minimum": -9007199254740991,
            "maximum": 9007199254740991
          },
          {
            "type": "null"
          }
        ]
      }
    },
    "required": [
      "id",
      "name",
      "latestValidatedVersion",
      "draftVersion"
    ]
  }
}
```

## `workflows.get`

Channel `relay/v1/workflows.get` · query · route `runner`

### Input

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "workflowId": {
      "type": "string",
      "pattern": "^wfl_[0-7][0-9A-HJKMNP-TV-Z]{25}$"
    },
    "version": {
      "anyOf": [
        {
          "type": "integer",
          "exclusiveMinimum": 0,
          "maximum": 9007199254740991
        },
        {
          "type": "string",
          "const": "draft"
        }
      ]
    }
  },
  "required": [
    "workflowId"
  ]
}
```

### Output

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "workflowId": {
      "type": "string",
      "pattern": "^wfl_[0-7][0-9A-HJKMNP-TV-Z]{25}$"
    },
    "version": {
      "anyOf": [
        {
          "type": "integer",
          "exclusiveMinimum": 0,
          "maximum": 9007199254740991
        },
        {
          "type": "string",
          "const": "draft"
        }
      ]
    },
    "status": {
      "type": "string",
      "enum": [
        "draft",
        "validated"
      ]
    },
    "draftRevision": {
      "anyOf": [
        {
          "type": "integer",
          "exclusiveMinimum": 0,
          "maximum": 9007199254740991
        },
        {
          "type": "null"
        }
      ]
    },
    "spec": {
      "type": "object",
      "properties": {
        "schemaVersion": {
          "type": "number",
          "const": 1
        },
        "id": {
          "type": "string",
          "pattern": "^[a-z0-9-]+$"
        },
        "version": {
          "type": "integer",
          "exclusiveMinimum": 0,
          "maximum": 9007199254740991
        },
        "name": {
          "type": "string",
          "minLength": 1,
          "maxLength": 80
        },
        "limits": {
          "type": "object",
          "properties": {
            "budgetMicrousd": {
              "type": "integer",
              "minimum": 0,
              "maximum": 9007199254740991
            },
            "maxRevisionCycles": {
              "type": "integer",
              "minimum": 0,
              "maximum": 5
            },
            "maxAttempts": {
              "type": "integer",
              "minimum": 1,
              "maximum": 50
            },
            "maxConcurrentSteps": {
              "type": "number",
              "const": 1
            },
            "executionTimeoutSeconds": {
              "type": "integer",
              "minimum": 60,
              "maximum": 7200
            },
            "maxToolCalls": {
              "type": "integer",
              "minimum": 0,
              "maximum": 0
            }
          },
          "additionalProperties": false
        },
        "steps": {
          "minItems": 1,
          "maxItems": 12,
          "type": "array",
          "items": {
            "oneOf": [
              {
                "type": "object",
                "properties": {
                  "id": {
                    "type": "string",
                    "pattern": "^[a-z][a-z0-9_-]{0,31}$"
                  },
                  "kind": {
                    "type": "string",
                    "const": "model"
                  },
                  "role": {
                    "type": "string",
                    "enum": [
                      "reviewer",
                      "planner",
                      "implementer",
                      "verifier"
                    ]
                  },
                  "profile": {
                    "type": "string"
                  },
                  "dependsOn": {
                    "type": "array",
                    "items": {
                      "type": "string",
                      "pattern": "^[a-z][a-z0-9_-]{0,31}$"
                    }
                  },
                  "outputSchema": {
                    "type": "string",
                    "enum": [
                      "findings.v1",
                      "plan.v1",
                      "patch.v1",
                      "review.v1"
                    ]
                  },
                  "instructionVersion": {
                    "type": "string",
                    "pattern": "^[a-z-]+\\.v\\d+$"
                  },
                  "maxOutputTokens": {
                    "type": "integer",
                    "exclusiveMinimum": 0,
                    "maximum": 9007199254740991
                  },
                  "retryPolicy": {
                    "default": {
                      "transport": 1,
                      "schemaRepair": 1,
                      "rateLimitWaits": 3
                    },
                    "type": "object",
                    "properties": {
                      "transport": {
                        "type": "integer",
                        "minimum": 0,
                        "maximum": 2
                      },
                      "schemaRepair": {
                        "type": "integer",
                        "minimum": 0,
                        "maximum": 2
                      },
                      "rateLimitWaits": {
                        "type": "integer",
                        "minimum": 0,
                        "maximum": 5
                      }
                    },
                    "required": [
                      "transport",
                      "schemaRepair",
                      "rateLimitWaits"
                    ],
                    "additionalProperties": false
                  },
                  "memoryScope": {
                    "default": {},
                    "type": "object",
                    "properties": {
                      "roles": {
                        "default": "step_role",
                        "anyOf": [
                          {
                            "type": "string",
                            "const": "step_role"
                          },
                          {
                            "type": "string",
                            "const": "all"
                          }
                        ]
                      },
                      "types": {
                        "default": [
                          "user_rule",
                          "project_decision",
                          "source_reference",
                          "run_summary"
                        ],
                        "type": "array",
                        "items": {
                          "type": "string",
                          "enum": [
                            "user_rule",
                            "project_decision",
                            "source_reference",
                            "run_summary"
                          ]
                        }
                      }
                    },
                    "additionalProperties": false
                  },
                  "allowedTools": {
                    "default": [],
                    "maxItems": 0,
                    "type": "array",
                    "items": {
                      "not": {}
                    }
                  }
                },
                "required": [
                  "id",
                  "kind",
                  "role",
                  "profile",
                  "outputSchema"
                ],
                "additionalProperties": false
              },
              {
                "type": "object",
                "properties": {
                  "id": {
                    "type": "string",
                    "pattern": "^[a-z][a-z0-9_-]{0,31}$"
                  },
                  "kind": {
                    "type": "string",
                    "const": "approval"
                  },
                  "dependsOn": {
                    "minItems": 1,
                    "type": "array",
                    "items": {
                      "type": "string",
                      "pattern": "^[a-z][a-z0-9_-]{0,31}$"
                    }
                  },
                  "bindTo": {
                    "minItems": 1,
                    "type": "array",
                    "items": {
                      "type": "string",
                      "enum": [
                        "planHash",
                        "contextHash"
                      ]
                    }
                  }
                },
                "required": [
                  "id",
                  "kind",
                  "dependsOn",
                  "bindTo"
                ],
                "additionalProperties": false
              }
            ]
          }
        },
        "revisionPolicy": {
          "type": "object",
          "properties": {
            "triggerStep": {
              "type": "string",
              "pattern": "^[a-z][a-z0-9_-]{0,31}$"
            },
            "triggerOutcome": {
              "type": "string",
              "const": "revise"
            },
            "repeatSteps": {
              "minItems": 1,
              "type": "array",
              "items": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9_-]{0,31}$"
              }
            },
            "approvalInvalidation": {
              "type": "string",
              "const": "require_new_approval_if_plan_or_scope_changes"
            },
            "onLimit": {
              "type": "string",
              "const": "incomplete"
            }
          },
          "required": [
            "triggerStep",
            "triggerOutcome",
            "repeatSteps",
            "approvalInvalidation",
            "onLimit"
          ],
          "additionalProperties": false
        }
      },
      "required": [
        "schemaVersion",
        "id",
        "version",
        "name",
        "limits",
        "steps",
        "revisionPolicy"
      ],
      "additionalProperties": false
    },
    "contentHash": {
      "type": "string",
      "pattern": "^[a-f0-9]{64}$"
    },
    "prompts": {
      "type": "object",
      "propertyNames": {
        "type": "string"
      },
      "additionalProperties": {
        "type": "object",
        "properties": {
          "instructionVersion": {
            "type": "string"
          },
          "role": {
            "type": "string",
            "enum": [
              "reviewer",
              "planner",
              "implementer",
              "verifier"
            ]
          },
          "text": {
            "type": "string"
          }
        },
        "required": [
          "instructionVersion",
          "role",
          "text"
        ]
      }
    },
    "editable": {
      "type": "object",
      "properties": {
        "prompts": {
          "type": "boolean"
        },
        "profiles": {
          "type": "boolean"
        },
        "limits": {
          "type": "boolean"
        },
        "maxOutputTokens": {
          "type": "boolean"
        },
        "retryPolicy": {
          "type": "boolean"
        },
        "memoryScope": {
          "type": "boolean"
        },
        "structure": {
          "type": "boolean",
          "const": false
        }
      },
      "required": [
        "prompts",
        "profiles",
        "limits",
        "maxOutputTokens",
        "retryPolicy",
        "memoryScope",
        "structure"
      ]
    }
  },
  "required": [
    "workflowId",
    "version",
    "status",
    "draftRevision",
    "spec",
    "contentHash",
    "prompts",
    "editable"
  ]
}
```

## `workflows.saveDraft`

Channel `relay/v1/workflows.saveDraft` · command · route `runner`

### Input

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "workflowId": {
      "type": "string",
      "pattern": "^wfl_[0-7][0-9A-HJKMNP-TV-Z]{25}$"
    },
    "expectedDraftRevision": {
      "type": "integer",
      "minimum": 0,
      "maximum": 9007199254740991
    },
    "patch": {
      "type": "object",
      "properties": {
        "prompts": {
          "type": "object",
          "propertyNames": {
            "type": "string"
          },
          "additionalProperties": {
            "type": "string",
            "minLength": 1,
            "maxLength": 20000
          }
        },
        "limits": {
          "type": "object",
          "properties": {
            "budgetMicrousd": {
              "type": "integer",
              "minimum": 0,
              "maximum": 9007199254740991
            },
            "maxRevisionCycles": {
              "type": "integer",
              "minimum": 0,
              "maximum": 5
            },
            "maxAttempts": {
              "type": "integer",
              "minimum": 1,
              "maximum": 50
            },
            "maxConcurrentSteps": {
              "type": "number",
              "const": 1
            },
            "executionTimeoutSeconds": {
              "type": "integer",
              "minimum": 60,
              "maximum": 7200
            },
            "maxToolCalls": {
              "type": "integer",
              "minimum": 0,
              "maximum": 0
            }
          }
        },
        "steps": {
          "type": "object",
          "propertyNames": {
            "type": "string",
            "pattern": "^[a-z][a-z0-9_-]{0,31}$"
          },
          "additionalProperties": {
            "type": "object",
            "properties": {
              "profile": {
                "type": "string",
                "minLength": 1,
                "maxLength": 40
              },
              "maxOutputTokens": {
                "type": "integer",
                "exclusiveMinimum": 0,
                "maximum": 9007199254740991
              },
              "retryPolicy": {
                "type": "object",
                "properties": {
                  "transport": {
                    "type": "integer",
                    "minimum": 0,
                    "maximum": 2
                  },
                  "schemaRepair": {
                    "type": "integer",
                    "minimum": 0,
                    "maximum": 2
                  },
                  "rateLimitWaits": {
                    "type": "integer",
                    "minimum": 0,
                    "maximum": 5
                  }
                },
                "required": [
                  "transport",
                  "schemaRepair",
                  "rateLimitWaits"
                ],
                "additionalProperties": false
              },
              "memoryScope": {
                "type": "object",
                "properties": {
                  "roles": {
                    "default": "step_role",
                    "anyOf": [
                      {
                        "type": "string",
                        "const": "step_role"
                      },
                      {
                        "type": "string",
                        "const": "all"
                      }
                    ]
                  },
                  "types": {
                    "default": [
                      "user_rule",
                      "project_decision",
                      "source_reference",
                      "run_summary"
                    ],
                    "type": "array",
                    "items": {
                      "type": "string",
                      "enum": [
                        "user_rule",
                        "project_decision",
                        "source_reference",
                        "run_summary"
                      ]
                    }
                  }
                },
                "additionalProperties": false
              }
            },
            "additionalProperties": false
          }
        }
      },
      "additionalProperties": false
    }
  },
  "required": [
    "workflowId",
    "expectedDraftRevision",
    "patch"
  ]
}
```

### Output

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "workflowId": {
      "type": "string",
      "pattern": "^wfl_[0-7][0-9A-HJKMNP-TV-Z]{25}$"
    },
    "version": {
      "anyOf": [
        {
          "type": "integer",
          "exclusiveMinimum": 0,
          "maximum": 9007199254740991
        },
        {
          "type": "string",
          "const": "draft"
        }
      ]
    },
    "status": {
      "type": "string",
      "enum": [
        "draft",
        "validated"
      ]
    },
    "draftRevision": {
      "anyOf": [
        {
          "type": "integer",
          "exclusiveMinimum": 0,
          "maximum": 9007199254740991
        },
        {
          "type": "null"
        }
      ]
    },
    "spec": {
      "type": "object",
      "properties": {
        "schemaVersion": {
          "type": "number",
          "const": 1
        },
        "id": {
          "type": "string",
          "pattern": "^[a-z0-9-]+$"
        },
        "version": {
          "type": "integer",
          "exclusiveMinimum": 0,
          "maximum": 9007199254740991
        },
        "name": {
          "type": "string",
          "minLength": 1,
          "maxLength": 80
        },
        "limits": {
          "type": "object",
          "properties": {
            "budgetMicrousd": {
              "type": "integer",
              "minimum": 0,
              "maximum": 9007199254740991
            },
            "maxRevisionCycles": {
              "type": "integer",
              "minimum": 0,
              "maximum": 5
            },
            "maxAttempts": {
              "type": "integer",
              "minimum": 1,
              "maximum": 50
            },
            "maxConcurrentSteps": {
              "type": "number",
              "const": 1
            },
            "executionTimeoutSeconds": {
              "type": "integer",
              "minimum": 60,
              "maximum": 7200
            },
            "maxToolCalls": {
              "type": "integer",
              "minimum": 0,
              "maximum": 0
            }
          },
          "additionalProperties": false
        },
        "steps": {
          "minItems": 1,
          "maxItems": 12,
          "type": "array",
          "items": {
            "oneOf": [
              {
                "type": "object",
                "properties": {
                  "id": {
                    "type": "string",
                    "pattern": "^[a-z][a-z0-9_-]{0,31}$"
                  },
                  "kind": {
                    "type": "string",
                    "const": "model"
                  },
                  "role": {
                    "type": "string",
                    "enum": [
                      "reviewer",
                      "planner",
                      "implementer",
                      "verifier"
                    ]
                  },
                  "profile": {
                    "type": "string"
                  },
                  "dependsOn": {
                    "type": "array",
                    "items": {
                      "type": "string",
                      "pattern": "^[a-z][a-z0-9_-]{0,31}$"
                    }
                  },
                  "outputSchema": {
                    "type": "string",
                    "enum": [
                      "findings.v1",
                      "plan.v1",
                      "patch.v1",
                      "review.v1"
                    ]
                  },
                  "instructionVersion": {
                    "type": "string",
                    "pattern": "^[a-z-]+\\.v\\d+$"
                  },
                  "maxOutputTokens": {
                    "type": "integer",
                    "exclusiveMinimum": 0,
                    "maximum": 9007199254740991
                  },
                  "retryPolicy": {
                    "default": {
                      "transport": 1,
                      "schemaRepair": 1,
                      "rateLimitWaits": 3
                    },
                    "type": "object",
                    "properties": {
                      "transport": {
                        "type": "integer",
                        "minimum": 0,
                        "maximum": 2
                      },
                      "schemaRepair": {
                        "type": "integer",
                        "minimum": 0,
                        "maximum": 2
                      },
                      "rateLimitWaits": {
                        "type": "integer",
                        "minimum": 0,
                        "maximum": 5
                      }
                    },
                    "required": [
                      "transport",
                      "schemaRepair",
                      "rateLimitWaits"
                    ],
                    "additionalProperties": false
                  },
                  "memoryScope": {
                    "default": {},
                    "type": "object",
                    "properties": {
                      "roles": {
                        "default": "step_role",
                        "anyOf": [
                          {
                            "type": "string",
                            "const": "step_role"
                          },
                          {
                            "type": "string",
                            "const": "all"
                          }
                        ]
                      },
                      "types": {
                        "default": [
                          "user_rule",
                          "project_decision",
                          "source_reference",
                          "run_summary"
                        ],
                        "type": "array",
                        "items": {
                          "type": "string",
                          "enum": [
                            "user_rule",
                            "project_decision",
                            "source_reference",
                            "run_summary"
                          ]
                        }
                      }
                    },
                    "additionalProperties": false
                  },
                  "allowedTools": {
                    "default": [],
                    "maxItems": 0,
                    "type": "array",
                    "items": {
                      "not": {}
                    }
                  }
                },
                "required": [
                  "id",
                  "kind",
                  "role",
                  "profile",
                  "outputSchema"
                ],
                "additionalProperties": false
              },
              {
                "type": "object",
                "properties": {
                  "id": {
                    "type": "string",
                    "pattern": "^[a-z][a-z0-9_-]{0,31}$"
                  },
                  "kind": {
                    "type": "string",
                    "const": "approval"
                  },
                  "dependsOn": {
                    "minItems": 1,
                    "type": "array",
                    "items": {
                      "type": "string",
                      "pattern": "^[a-z][a-z0-9_-]{0,31}$"
                    }
                  },
                  "bindTo": {
                    "minItems": 1,
                    "type": "array",
                    "items": {
                      "type": "string",
                      "enum": [
                        "planHash",
                        "contextHash"
                      ]
                    }
                  }
                },
                "required": [
                  "id",
                  "kind",
                  "dependsOn",
                  "bindTo"
                ],
                "additionalProperties": false
              }
            ]
          }
        },
        "revisionPolicy": {
          "type": "object",
          "properties": {
            "triggerStep": {
              "type": "string",
              "pattern": "^[a-z][a-z0-9_-]{0,31}$"
            },
            "triggerOutcome": {
              "type": "string",
              "const": "revise"
            },
            "repeatSteps": {
              "minItems": 1,
              "type": "array",
              "items": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9_-]{0,31}$"
              }
            },
            "approvalInvalidation": {
              "type": "string",
              "const": "require_new_approval_if_plan_or_scope_changes"
            },
            "onLimit": {
              "type": "string",
              "const": "incomplete"
            }
          },
          "required": [
            "triggerStep",
            "triggerOutcome",
            "repeatSteps",
            "approvalInvalidation",
            "onLimit"
          ],
          "additionalProperties": false
        }
      },
      "required": [
        "schemaVersion",
        "id",
        "version",
        "name",
        "limits",
        "steps",
        "revisionPolicy"
      ],
      "additionalProperties": false
    },
    "contentHash": {
      "type": "string",
      "pattern": "^[a-f0-9]{64}$"
    },
    "prompts": {
      "type": "object",
      "propertyNames": {
        "type": "string"
      },
      "additionalProperties": {
        "type": "object",
        "properties": {
          "instructionVersion": {
            "type": "string"
          },
          "role": {
            "type": "string",
            "enum": [
              "reviewer",
              "planner",
              "implementer",
              "verifier"
            ]
          },
          "text": {
            "type": "string"
          }
        },
        "required": [
          "instructionVersion",
          "role",
          "text"
        ]
      }
    },
    "editable": {
      "type": "object",
      "properties": {
        "prompts": {
          "type": "boolean"
        },
        "profiles": {
          "type": "boolean"
        },
        "limits": {
          "type": "boolean"
        },
        "maxOutputTokens": {
          "type": "boolean"
        },
        "retryPolicy": {
          "type": "boolean"
        },
        "memoryScope": {
          "type": "boolean"
        },
        "structure": {
          "type": "boolean",
          "const": false
        }
      },
      "required": [
        "prompts",
        "profiles",
        "limits",
        "maxOutputTokens",
        "retryPolicy",
        "memoryScope",
        "structure"
      ]
    }
  },
  "required": [
    "workflowId",
    "version",
    "status",
    "draftRevision",
    "spec",
    "contentHash",
    "prompts",
    "editable"
  ]
}
```

## `workflows.validate`

Channel `relay/v1/workflows.validate` · query · route `runner`

### Input

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "workflowId": {
      "type": "string",
      "pattern": "^wfl_[0-7][0-9A-HJKMNP-TV-Z]{25}$"
    },
    "version": {
      "anyOf": [
        {
          "type": "integer",
          "exclusiveMinimum": 0,
          "maximum": 9007199254740991
        },
        {
          "type": "string",
          "const": "draft"
        }
      ]
    }
  },
  "required": [
    "workflowId",
    "version"
  ]
}
```

### Output

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "valid": {
      "type": "boolean"
    },
    "issues": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "path": {
            "type": "string"
          },
          "message": {
            "type": "string",
            "maxLength": 400
          },
          "code": {
            "type": "string",
            "maxLength": 64
          }
        },
        "required": [
          "path",
          "message",
          "code"
        ]
      }
    },
    "warnings": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "stepKey": {
            "anyOf": [
              {
                "type": "string",
                "pattern": "^[a-z][a-z0-9_-]{0,31}$"
              },
              {
                "type": "null"
              }
            ]
          },
          "profileId": {
            "anyOf": [
              {
                "type": "string",
                "pattern": "^prf_[0-7][0-9A-HJKMNP-TV-Z]{25}$"
              },
              {
                "type": "null"
              }
            ]
          },
          "code": {
            "type": "string",
            "enum": [
              "structured_output_unsupported",
              "effort_unsupported",
              "output_budget_low",
              "input_budget_low",
              "missing_credential",
              "provider_not_allowed",
              "model_unknown"
            ]
          },
          "message": {
            "type": "string",
            "maxLength": 400
          }
        },
        "required": [
          "stepKey",
          "profileId",
          "code",
          "message"
        ]
      }
    }
  },
  "required": [
    "valid",
    "issues",
    "warnings"
  ]
}
```

## `workflows.publish`

Channel `relay/v1/workflows.publish` · command · route `runner`

### Input

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "idempotencyKey": {
      "type": "string",
      "minLength": 10,
      "maxLength": 64
    },
    "workflowId": {
      "type": "string",
      "pattern": "^wfl_[0-7][0-9A-HJKMNP-TV-Z]{25}$"
    }
  },
  "required": [
    "idempotencyKey",
    "workflowId"
  ]
}
```

### Output

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "workflowId": {
      "type": "string",
      "pattern": "^wfl_[0-7][0-9A-HJKMNP-TV-Z]{25}$"
    },
    "version": {
      "anyOf": [
        {
          "type": "integer",
          "exclusiveMinimum": 0,
          "maximum": 9007199254740991
        },
        {
          "type": "string",
          "const": "draft"
        }
      ]
    },
    "status": {
      "type": "string",
      "enum": [
        "draft",
        "validated"
      ]
    },
    "draftRevision": {
      "anyOf": [
        {
          "type": "integer",
          "exclusiveMinimum": 0,
          "maximum": 9007199254740991
        },
        {
          "type": "null"
        }
      ]
    },
    "spec": {
      "type": "object",
      "properties": {
        "schemaVersion": {
          "type": "number",
          "const": 1
        },
        "id": {
          "type": "string",
          "pattern": "^[a-z0-9-]+$"
        },
        "version": {
          "type": "integer",
          "exclusiveMinimum": 0,
          "maximum": 9007199254740991
        },
        "name": {
          "type": "string",
          "minLength": 1,
          "maxLength": 80
        },
        "limits": {
          "type": "object",
          "properties": {
            "budgetMicrousd": {
              "type": "integer",
              "minimum": 0,
              "maximum": 9007199254740991
            },
            "maxRevisionCycles": {
              "type": "integer",
              "minimum": 0,
              "maximum": 5
            },
            "maxAttempts": {
              "type": "integer",
              "minimum": 1,
              "maximum": 50
            },
            "maxConcurrentSteps": {
              "type": "number",
              "const": 1
            },
            "executionTimeoutSeconds": {
              "type": "integer",
              "minimum": 60,
              "maximum": 7200
            },
            "maxToolCalls": {
              "type": "integer",
              "minimum": 0,
              "maximum": 0
            }
          },
          "additionalProperties": false
        },
        "steps": {
          "minItems": 1,
          "maxItems": 12,
          "type": "array",
          "items": {
            "oneOf": [
              {
                "type": "object",
                "properties": {
                  "id": {
                    "type": "string",
                    "pattern": "^[a-z][a-z0-9_-]{0,31}$"
                  },
                  "kind": {
                    "type": "string",
                    "const": "model"
                  },
                  "role": {
                    "type": "string",
                    "enum": [
                      "reviewer",
                      "planner",
                      "implementer",
                      "verifier"
                    ]
                  },
                  "profile": {
                    "type": "string"
                  },
                  "dependsOn": {
                    "type": "array",
                    "items": {
                      "type": "string",
                      "pattern": "^[a-z][a-z0-9_-]{0,31}$"
                    }
                  },
                  "outputSchema": {
                    "type": "string",
                    "enum": [
                      "findings.v1",
                      "plan.v1",
                      "patch.v1",
                      "review.v1"
                    ]
                  },
                  "instructionVersion": {
                    "type": "string",
                    "pattern": "^[a-z-]+\\.v\\d+$"
                  },
                  "maxOutputTokens": {
                    "type": "integer",
                    "exclusiveMinimum": 0,
                    "maximum": 9007199254740991
                  },
                  "retryPolicy": {
                    "default": {
                      "transport": 1,
                      "schemaRepair": 1,
                      "rateLimitWaits": 3
                    },
                    "type": "object",
                    "properties": {
                      "transport": {
                        "type": "integer",
                        "minimum": 0,
                        "maximum": 2
                      },
                      "schemaRepair": {
                        "type": "integer",
                        "minimum": 0,
                        "maximum": 2
                      },
                      "rateLimitWaits": {
                        "type": "integer",
                        "minimum": 0,
                        "maximum": 5
                      }
                    },
                    "required": [
                      "transport",
                      "schemaRepair",
                      "rateLimitWaits"
                    ],
                    "additionalProperties": false
                  },
                  "memoryScope": {
                    "default": {},
                    "type": "object",
                    "properties": {
                      "roles": {
                        "default": "step_role",
                        "anyOf": [
                          {
                            "type": "string",
                            "const": "step_role"
                          },
                          {
                            "type": "string",
                            "const": "all"
                          }
                        ]
                      },
                      "types": {
                        "default": [
                          "user_rule",
                          "project_decision",
                          "source_reference",
                          "run_summary"
                        ],
                        "type": "array",
                        "items": {
                          "type": "string",
                          "enum": [
                            "user_rule",
                            "project_decision",
                            "source_reference",
                            "run_summary"
                          ]
                        }
                      }
                    },
                    "additionalProperties": false
                  },
                  "allowedTools": {
                    "default": [],
                    "maxItems": 0,
                    "type": "array",
                    "items": {
                      "not": {}
                    }
                  }
                },
                "required": [
                  "id",
                  "kind",
                  "role",
                  "profile",
                  "outputSchema"
                ],
                "additionalProperties": false
              },
              {
                "type": "object",
                "properties": {
                  "id": {
                    "type": "string",
                    "pattern": "^[a-z][a-z0-9_-]{0,31}$"
                  },
                  "kind": {
                    "type": "string",
                    "const": "approval"
                  },
                  "dependsOn": {
                    "minItems": 1,
                    "type": "array",
                    "items": {
                      "type": "string",
                      "pattern": "^[a-z][a-z0-9_-]{0,31}$"
                    }
                  },
                  "bindTo": {
                    "minItems": 1,
                    "type": "array",
                    "items": {
                      "type": "string",
                      "enum": [
                        "planHash",
                        "contextHash"
                      ]
                    }
                  }
                },
                "required": [
                  "id",
                  "kind",
                  "dependsOn",
                  "bindTo"
                ],
                "additionalProperties": false
              }
            ]
          }
        },
        "revisionPolicy": {
          "type": "object",
          "properties": {
            "triggerStep": {
              "type": "string",
              "pattern": "^[a-z][a-z0-9_-]{0,31}$"
            },
            "triggerOutcome": {
              "type": "string",
              "const": "revise"
            },
            "repeatSteps": {
              "minItems": 1,
              "type": "array",
              "items": {
                "type": "string",
                "pattern": "^[a-z][a-z0-9_-]{0,31}$"
              }
            },
            "approvalInvalidation": {
              "type": "string",
              "const": "require_new_approval_if_plan_or_scope_changes"
            },
            "onLimit": {
              "type": "string",
              "const": "incomplete"
            }
          },
          "required": [
            "triggerStep",
            "triggerOutcome",
            "repeatSteps",
            "approvalInvalidation",
            "onLimit"
          ],
          "additionalProperties": false
        }
      },
      "required": [
        "schemaVersion",
        "id",
        "version",
        "name",
        "limits",
        "steps",
        "revisionPolicy"
      ],
      "additionalProperties": false
    },
    "contentHash": {
      "type": "string",
      "pattern": "^[a-f0-9]{64}$"
    },
    "prompts": {
      "type": "object",
      "propertyNames": {
        "type": "string"
      },
      "additionalProperties": {
        "type": "object",
        "properties": {
          "instructionVersion": {
            "type": "string"
          },
          "role": {
            "type": "string",
            "enum": [
              "reviewer",
              "planner",
              "implementer",
              "verifier"
            ]
          },
          "text": {
            "type": "string"
          }
        },
        "required": [
          "instructionVersion",
          "role",
          "text"
        ]
      }
    },
    "editable": {
      "type": "object",
      "properties": {
        "prompts": {
          "type": "boolean"
        },
        "profiles": {
          "type": "boolean"
        },
        "limits": {
          "type": "boolean"
        },
        "maxOutputTokens": {
          "type": "boolean"
        },
        "retryPolicy": {
          "type": "boolean"
        },
        "memoryScope": {
          "type": "boolean"
        },
        "structure": {
          "type": "boolean",
          "const": false
        }
      },
      "required": [
        "prompts",
        "profiles",
        "limits",
        "maxOutputTokens",
        "retryPolicy",
        "memoryScope",
        "structure"
      ]
    }
  },
  "required": [
    "workflowId",
    "version",
    "status",
    "draftRevision",
    "spec",
    "contentHash",
    "prompts",
    "editable"
  ]
}
```

## `runs.preflight`

Channel `relay/v1/runs.preflight` · query · route `runner`

### Input

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "projectId": {
      "type": "string",
      "pattern": "^prj_[0-7][0-9A-HJKMNP-TV-Z]{25}$"
    },
    "workflowId": {
      "type": "string",
      "pattern": "^wfl_[0-7][0-9A-HJKMNP-TV-Z]{25}$"
    },
    "workflowVersion": {
      "type": "integer",
      "exclusiveMinimum": 0,
      "maximum": 9007199254740991
    },
    "goal": {
      "type": "string",
      "minLength": 1,
      "maxLength": 2000
    },
    "input": {
      "oneOf": [
        {
          "type": "object",
          "properties": {
            "kind": {
              "type": "string",
              "const": "files"
            },
            "relPaths": {
              "minItems": 1,
              "maxItems": 200,
              "type": "array",
              "items": {
                "type": "string",
                "minLength": 1,
                "maxLength": 512
              }
            }
          },
          "required": [
            "kind",
            "relPaths"
          ]
        },
        {
          "type": "object",
          "properties": {
            "kind": {
              "type": "string",
              "const": "diff"
            },
            "diffArtifactId": {
              "type": "string",
              "pattern": "^art_[0-7][0-9A-HJKMNP-TV-Z]{25}$"
            }
          },
          "required": [
            "kind",
            "diffArtifactId"
          ]
        }
      ]
    },
    "limitOverrides": {
      "type": "object",
      "properties": {
        "budgetMicrousd": {
          "type": "integer",
          "minimum": 0,
          "maximum": 9007199254740991
        },
        "maxRevisionCycles": {
          "type": "integer",
          "minimum": 0,
          "maximum": 5
        },
        "maxAttempts": {
          "type": "integer",
          "minimum": 1,
          "maximum": 50
        },
        "maxConcurrentSteps": {
          "type": "number",
          "const": 1
        },
        "executionTimeoutSeconds": {
          "type": "integer",
          "minimum": 60,
          "maximum": 7200
        },
        "maxToolCalls": {
          "type": "integer",
          "minimum": 0,
          "maximum": 0
        }
      }
    },
    "profileOverrides": {
      "type": "object",
      "propertyNames": {
        "type": "string",
        "pattern": "^[a-z][a-z0-9_-]{0,31}$"
      },
      "additionalProperties": {
        "type": "string",
        "pattern": "^prf_[0-7][0-9A-HJKMNP-TV-Z]{25}$"
      }
    },
    "memoryRecordIds": {
      "maxItems": 50,
      "type": "array",
      "items": {
        "type": "string",
        "pattern": "^mem_[0-7][0-9A-HJKMNP-TV-Z]{25}$"
      }
    }
  },
  "required": [
    "projectId",
    "workflowId",
    "workflowVersion",
    "goal",
    "input"
  ]
}
```

### Output

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "inputSummary": {
      "type": "object",
      "properties": {
        "files": {
          "type": "integer",
          "minimum": 0,
          "maximum": 9007199254740991
        },
        "bytes": {
          "type": "integer",
          "minimum": 0,
          "maximum": 9007199254740991
        },
        "estimatedInputTokens": {
          "type": "integer",
          "minimum": 0,
          "maximum": 9007199254740991
        },
        "memoryRecords": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "id": {
                "type": "string",
                "pattern": "^mem_[0-7][0-9A-HJKMNP-TV-Z]{25}$"
              },
              "revision": {
                "type": "integer",
                "exclusiveMinimum": 0,
                "maximum": 9007199254740991
              },
              "type": {
                "type": "string",
                "enum": [
                  "user_rule",
                  "project_decision",
                  "source_reference",
                  "run_summary"
                ]
              },
              "title": {
                "type": "string"
              },
              "pinned": {
                "type": "boolean"
              }
            },
            "required": [
              "id",
              "revision",
              "type",
              "title",
              "pinned"
            ]
          }
        },
        "providersReceivingContext": {
          "type": "array",
          "items": {
            "type": "string",
            "enum": [
              "anthropic",
              "openai",
              "gemini",
              "fake"
            ]
          }
        }
      },
      "required": [
        "files",
        "bytes",
        "estimatedInputTokens",
        "memoryRecords",
        "providersReceivingContext"
      ]
    },
    "firstReservation": {
      "type": "object",
      "properties": {
        "N": {
          "type": "integer",
          "minimum": 0,
          "maximum": 9007199254740991
        },
        "basis": {
          "type": "string",
          "enum": [
            "provider_count",
            "local_estimate"
          ]
        }
      },
      "required": [
        "N",
        "basis"
      ]
    },
    "budget": {
      "type": "object",
      "properties": {
        "L": {
          "type": "integer",
          "minimum": -9007199254740991,
          "maximum": 9007199254740991
        },
        "C": {
          "type": "integer",
          "minimum": -9007199254740991,
          "maximum": 9007199254740991
        },
        "R": {
          "type": "integer",
          "minimum": -9007199254740991,
          "maximum": 9007199254740991
        },
        "U": {
          "type": "integer",
          "minimum": -9007199254740991,
          "maximum": 9007199254740991
        },
        "N": {
          "type": "integer",
          "minimum": 0,
          "maximum": 9007199254740991
        },
        "scope": {
          "type": "string",
          "enum": [
            "run",
            "project",
            "setup"
          ]
        },
        "total": {
          "type": "integer",
          "minimum": -9007199254740991,
          "maximum": 9007199254740991
        },
        "allowed": {
          "type": "boolean"
        }
      },
      "required": [
        "L",
        "C",
        "R",
        "U",
        "N",
        "scope",
        "total",
        "allowed"
      ]
    },
    "issues": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "path": {
            "type": "string"
          },
          "message": {
            "type": "string",
            "maxLength": 400
          },
          "code": {
            "type": "string",
            "maxLength": 64
          }
        },
        "required": [
          "path",
          "message",
          "code"
        ]
      }
    }
  },
  "required": [
    "inputSummary",
    "firstReservation",
    "budget",
    "issues"
  ]
}
```

## `runs.start`

Channel `relay/v1/runs.start` · command · route `runner`

### Input

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "idempotencyKey": {
      "type": "string",
      "minLength": 10,
      "maxLength": 64
    },
    "projectId": {
      "type": "string",
      "pattern": "^prj_[0-7][0-9A-HJKMNP-TV-Z]{25}$"
    },
    "workflowId": {
      "type": "string",
      "pattern": "^wfl_[0-7][0-9A-HJKMNP-TV-Z]{25}$"
    },
    "workflowVersion": {
      "type": "integer",
      "exclusiveMinimum": 0,
      "maximum": 9007199254740991
    },
    "goal": {
      "type": "string",
      "minLength": 1,
      "maxLength": 2000
    },
    "input": {
      "oneOf": [
        {
          "type": "object",
          "properties": {
            "kind": {
              "type": "string",
              "const": "files"
            },
            "relPaths": {
              "minItems": 1,
              "maxItems": 200,
              "type": "array",
              "items": {
                "type": "string",
                "minLength": 1,
                "maxLength": 512
              }
            }
          },
          "required": [
            "kind",
            "relPaths"
          ]
        },
        {
          "type": "object",
          "properties": {
            "kind": {
              "type": "string",
              "const": "diff"
            },
            "diffArtifactId": {
              "type": "string",
              "pattern": "^art_[0-7][0-9A-HJKMNP-TV-Z]{25}$"
            }
          },
          "required": [
            "kind",
            "diffArtifactId"
          ]
        }
      ]
    },
    "limitOverrides": {
      "type": "object",
      "properties": {
        "budgetMicrousd": {
          "type": "integer",
          "minimum": 0,
          "maximum": 9007199254740991
        },
        "maxRevisionCycles": {
          "type": "integer",
          "minimum": 0,
          "maximum": 5
        },
        "maxAttempts": {
          "type": "integer",
          "minimum": 1,
          "maximum": 50
        },
        "maxConcurrentSteps": {
          "type": "number",
          "const": 1
        },
        "executionTimeoutSeconds": {
          "type": "integer",
          "minimum": 60,
          "maximum": 7200
        },
        "maxToolCalls": {
          "type": "integer",
          "minimum": 0,
          "maximum": 0
        }
      }
    },
    "profileOverrides": {
      "type": "object",
      "propertyNames": {
        "type": "string",
        "pattern": "^[a-z][a-z0-9_-]{0,31}$"
      },
      "additionalProperties": {
        "type": "string",
        "pattern": "^prf_[0-7][0-9A-HJKMNP-TV-Z]{25}$"
      }
    },
    "memoryRecordIds": {
      "maxItems": 50,
      "type": "array",
      "items": {
        "type": "string",
        "pattern": "^mem_[0-7][0-9A-HJKMNP-TV-Z]{25}$"
      }
    }
  },
  "required": [
    "idempotencyKey",
    "projectId",
    "workflowId",
    "workflowVersion",
    "goal",
    "input"
  ]
}
```

### Output

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "runId": {
      "type": "string",
      "pattern": "^run_[0-7][0-9A-HJKMNP-TV-Z]{25}$"
    },
    "status": {
      "type": "string",
      "enum": [
        "queued",
        "running",
        "awaiting_approval",
        "paused",
        "interrupted",
        "cancelling",
        "cancelled",
        "completed",
        "incomplete",
        "failed"
      ]
    }
  },
  "required": [
    "runId",
    "status"
  ]
}
```

## `runs.list`

Channel `relay/v1/runs.list` · query · route `runner`

### Input

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "projectId": {
      "type": "string",
      "pattern": "^prj_[0-7][0-9A-HJKMNP-TV-Z]{25}$"
    },
    "status": {
      "type": "array",
      "items": {
        "type": "string",
        "enum": [
          "queued",
          "running",
          "awaiting_approval",
          "paused",
          "interrupted",
          "cancelling",
          "cancelled",
          "completed",
          "incomplete",
          "failed"
        ]
      }
    },
    "sort": {
      "default": "created_desc",
      "type": "string",
      "enum": [
        "created_desc",
        "created_asc"
      ]
    },
    "limit": {
      "default": 25,
      "type": "integer",
      "minimum": 1,
      "maximum": 100
    },
    "cursor": {
      "type": "string",
      "minLength": 1,
      "maxLength": 512
    }
  },
  "required": [
    "projectId"
  ]
}
```

### Output

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "items": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "id": {
            "type": "string",
            "pattern": "^run_[0-7][0-9A-HJKMNP-TV-Z]{25}$"
          },
          "projectId": {
            "type": "string",
            "pattern": "^prj_[0-7][0-9A-HJKMNP-TV-Z]{25}$"
          },
          "goal": {
            "type": "string"
          },
          "workflow": {
            "type": "object",
            "properties": {
              "id": {
                "type": "string",
                "pattern": "^wfl_[0-7][0-9A-HJKMNP-TV-Z]{25}$"
              },
              "version": {
                "type": "integer",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991
              },
              "name": {
                "type": "string"
              }
            },
            "required": [
              "id",
              "version",
              "name"
            ]
          },
          "status": {
            "type": "string",
            "enum": [
              "queued",
              "running",
              "awaiting_approval",
              "paused",
              "interrupted",
              "cancelling",
              "cancelled",
              "completed",
              "incomplete",
              "failed"
            ]
          },
          "pauseReason": {
            "anyOf": [
              {
                "type": "string",
                "enum": [
                  "budget_run",
                  "budget_project",
                  "user",
                  "auth_required",
                  "rate_limited",
                  "setup_blocked",
                  "approval_stale",
                  "deadline",
                  "limit_attempts",
                  "unknown_outcome",
                  "output_invalid",
                  "provider_unavailable",
                  "budget_overrun",
                  "model_refused"
                ]
              },
              {
                "type": "null"
              }
            ]
          },
          "stepProgress": {
            "type": "object",
            "properties": {
              "done": {
                "type": "integer",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991
              },
              "total": {
                "type": "integer",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991
              }
            },
            "required": [
              "done",
              "total"
            ]
          },
          "cost": {
            "type": "object",
            "properties": {
              "allowance": {
                "type": "integer",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991
              },
              "settledReported": {
                "type": "integer",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991
              },
              "settledCalculated": {
                "type": "integer",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991
              },
              "settledEstimated": {
                "type": "integer",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991
              },
              "reserved": {
                "type": "integer",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991
              },
              "unknown": {
                "type": "integer",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991
              },
              "remaining": {
                "type": "integer",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991
              },
              "overrun": {
                "type": "boolean"
              }
            },
            "required": [
              "allowance",
              "settledReported",
              "settledCalculated",
              "settledEstimated",
              "reserved",
              "unknown",
              "remaining",
              "overrun"
            ]
          },
          "createdAt": {
            "type": "integer",
            "minimum": 0,
            "maximum": 9007199254740991
          },
          "startedAt": {
            "anyOf": [
              {
                "type": "integer",
                "minimum": 0,
                "maximum": 9007199254740991
              },
              {
                "type": "null"
              }
            ]
          },
          "endedAt": {
            "anyOf": [
              {
                "type": "integer",
                "minimum": 0,
                "maximum": 9007199254740991
              },
              {
                "type": "null"
              }
            ]
          }
        },
        "required": [
          "id",
          "projectId",
          "goal",
          "workflow",
          "status",
          "pauseReason",
          "stepProgress",
          "cost",
          "createdAt",
          "startedAt",
          "endedAt"
        ]
      }
    },
    "nextCursor": {
      "type": [
        "string",
        "null"
      ]
    }
  },
  "required": [
    "items",
    "nextCursor"
  ]
}
```

## `runs.get`

Channel `relay/v1/runs.get` · query · route `runner`

### Input

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "runId": {
      "type": "string",
      "pattern": "^run_[0-7][0-9A-HJKMNP-TV-Z]{25}$"
    }
  },
  "required": [
    "runId"
  ]
}
```

### Output

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "id": {
      "type": "string",
      "pattern": "^run_[0-7][0-9A-HJKMNP-TV-Z]{25}$"
    },
    "projectId": {
      "type": "string",
      "pattern": "^prj_[0-7][0-9A-HJKMNP-TV-Z]{25}$"
    },
    "goal": {
      "type": "string"
    },
    "workflow": {
      "type": "object",
      "properties": {
        "id": {
          "type": "string",
          "pattern": "^wfl_[0-7][0-9A-HJKMNP-TV-Z]{25}$"
        },
        "version": {
          "type": "integer",
          "minimum": -9007199254740991,
          "maximum": 9007199254740991
        },
        "name": {
          "type": "string"
        }
      },
      "required": [
        "id",
        "version",
        "name"
      ]
    },
    "status": {
      "type": "string",
      "enum": [
        "queued",
        "running",
        "awaiting_approval",
        "paused",
        "interrupted",
        "cancelling",
        "cancelled",
        "completed",
        "incomplete",
        "failed"
      ]
    },
    "pauseReason": {
      "anyOf": [
        {
          "type": "string",
          "enum": [
            "budget_run",
            "budget_project",
            "user",
            "auth_required",
            "rate_limited",
            "setup_blocked",
            "approval_stale",
            "deadline",
            "limit_attempts",
            "unknown_outcome",
            "output_invalid",
            "provider_unavailable",
            "budget_overrun",
            "model_refused"
          ]
        },
        {
          "type": "null"
        }
      ]
    },
    "stepProgress": {
      "type": "object",
      "properties": {
        "done": {
          "type": "integer",
          "minimum": -9007199254740991,
          "maximum": 9007199254740991
        },
        "total": {
          "type": "integer",
          "minimum": -9007199254740991,
          "maximum": 9007199254740991
        }
      },
      "required": [
        "done",
        "total"
      ]
    },
    "cost": {
      "type": "object",
      "properties": {
        "allowance": {
          "type": "integer",
          "minimum": -9007199254740991,
          "maximum": 9007199254740991
        },
        "settledReported": {
          "type": "integer",
          "minimum": -9007199254740991,
          "maximum": 9007199254740991
        },
        "settledCalculated": {
          "type": "integer",
          "minimum": -9007199254740991,
          "maximum": 9007199254740991
        },
        "settledEstimated": {
          "type": "integer",
          "minimum": -9007199254740991,
          "maximum": 9007199254740991
        },
        "reserved": {
          "type": "integer",
          "minimum": -9007199254740991,
          "maximum": 9007199254740991
        },
        "unknown": {
          "type": "integer",
          "minimum": -9007199254740991,
          "maximum": 9007199254740991
        },
        "remaining": {
          "type": "integer",
          "minimum": -9007199254740991,
          "maximum": 9007199254740991
        },
        "overrun": {
          "type": "boolean"
        }
      },
      "required": [
        "allowance",
        "settledReported",
        "settledCalculated",
        "settledEstimated",
        "reserved",
        "unknown",
        "remaining",
        "overrun"
      ]
    },
    "createdAt": {
      "type": "integer",
      "minimum": 0,
      "maximum": 9007199254740991
    },
    "startedAt": {
      "anyOf": [
        {
          "type": "integer",
          "minimum": 0,
          "maximum": 9007199254740991
        },
        {
          "type": "null"
        }
      ]
    },
    "endedAt": {
      "anyOf": [
        {
          "type": "integer",
          "minimum": 0,
          "maximum": 9007199254740991
        },
        {
          "type": "null"
        }
      ]
    },
    "limits": {
      "type": "object",
      "properties": {
        "budgetMicrousd": {
          "type": "integer",
          "minimum": 0,
          "maximum": 9007199254740991
        },
        "maxRevisionCycles": {
          "type": "integer",
          "minimum": 0,
          "maximum": 5
        },
        "maxAttempts": {
          "type": "integer",
          "minimum": 1,
          "maximum": 50
        },
        "maxConcurrentSteps": {
          "type": "number",
          "const": 1
        },
        "executionTimeoutSeconds": {
          "type": "integer",
          "minimum": 60,
          "maximum": 7200
        },
        "maxToolCalls": {
          "type": "integer",
          "minimum": 0,
          "maximum": 0
        }
      },
      "required": [
        "budgetMicrousd",
        "maxRevisionCycles",
        "maxAttempts",
        "maxConcurrentSteps",
        "executionTimeoutSeconds",
        "maxToolCalls"
      ]
    },
    "input": {
      "oneOf": [
        {
          "type": "object",
          "properties": {
            "kind": {
              "type": "string",
              "const": "files"
            },
            "relPaths": {
              "minItems": 1,
              "maxItems": 200,
              "type": "array",
              "items": {
                "type": "string",
                "minLength": 1,
                "maxLength": 512
              }
            }
          },
          "required": [
            "kind",
            "relPaths"
          ]
        },
        {
          "type": "object",
          "properties": {
            "kind": {
              "type": "string",
              "const": "diff"
            },
            "diffArtifactId": {
              "type": "string",
              "pattern": "^art_[0-7][0-9A-HJKMNP-TV-Z]{25}$"
            }
          },
          "required": [
            "kind",
            "diffArtifactId"
          ]
        }
      ]
    },
    "contextHash": {
      "anyOf": [
        {
          "type": "string",
          "pattern": "^[a-f0-9]{64}$"
        },
        {
          "type": "null"
        }
      ]
    },
    "steps": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "id": {
            "type": "string",
            "pattern": "^stp_[0-7][0-9A-HJKMNP-TV-Z]{25}$"
          },
          "stepKey": {
            "type": "string",
            "pattern": "^[a-z][a-z0-9_-]{0,31}$"
          },
          "revisionIndex": {
            "type": "integer",
            "minimum": 0,
            "maximum": 9007199254740991
          },
          "retryIndex": {
            "type": "integer",
            "minimum": 0,
            "maximum": 9007199254740991
          },
          "state": {
            "type": "string",
            "enum": [
              "pending",
              "ready",
              "reserved",
              "executing",
              "validating",
              "awaiting_approval",
              "succeeded",
              "failed",
              "unknown",
              "skipped"
            ]
          },
          "profileName": {
            "type": [
              "string",
              "null"
            ]
          },
          "providerId": {
            "anyOf": [
              {
                "type": "string",
                "enum": [
                  "anthropic",
                  "openai",
                  "gemini",
                  "fake"
                ]
              },
              {
                "type": "null"
              }
            ]
          },
          "modelId": {
            "type": [
              "string",
              "null"
            ]
          },
          "outcome": {
            "type": [
              "string",
              "null"
            ]
          },
          "outputArtifactId": {
            "anyOf": [
              {
                "type": "string",
                "pattern": "^art_[0-7][0-9A-HJKMNP-TV-Z]{25}$"
              },
              {
                "type": "null"
              }
            ]
          },
          "error": {
            "anyOf": [
              {
                "type": "object",
                "properties": {
                  "code": {
                    "type": "string",
                    "enum": [
                      "AUTH_REQUIRED",
                      "MODEL_UNSUPPORTED",
                      "RATE_LIMITED",
                      "BUDGET_BLOCKED",
                      "CONTEXT_TOO_LARGE",
                      "OUTPUT_INVALID",
                      "APPROVAL_STALE",
                      "PROJECT_CHANGED",
                      "REQUEST_OUTCOME_UNKNOWN",
                      "ARTIFACT_WRITE_FAILED",
                      "RUNNER_UNAVAILABLE",
                      "PROVIDER_UNAVAILABLE",
                      "VALIDATION_FAILED",
                      "NOT_FOUND",
                      "CONFLICT",
                      "LIMIT_REACHED",
                      "PERMISSION_DENIED",
                      "SECURE_STORAGE_UNAVAILABLE",
                      "MODEL_REFUSED",
                      "INTERNAL"
                    ]
                  },
                  "userMessage": {
                    "type": "string",
                    "maxLength": 400
                  },
                  "retryable": {
                    "type": "boolean"
                  },
                  "nextAction": {
                    "type": "string",
                    "enum": [
                      "reconnect_provider",
                      "choose_profile",
                      "wait",
                      "increase_allowance",
                      "stop",
                      "narrow_scope",
                      "retry_step",
                      "reapprove",
                      "resnapshot_and_replan",
                      "use_preserved_snapshot",
                      "decide_unknown",
                      "retry_export",
                      "restart_runner",
                      "fix_input",
                      "none",
                      "reload",
                      "raise_limits",
                      "edit_policy",
                      "use_session_key",
                      "edit_goal",
                      "report_bug"
                    ]
                  },
                  "alternatives": {
                    "default": [],
                    "type": "array",
                    "items": {
                      "type": "string",
                      "enum": [
                        "reconnect_provider",
                        "choose_profile",
                        "wait",
                        "increase_allowance",
                        "stop",
                        "narrow_scope",
                        "retry_step",
                        "reapprove",
                        "resnapshot_and_replan",
                        "use_preserved_snapshot",
                        "decide_unknown",
                        "retry_export",
                        "restart_runner",
                        "fix_input",
                        "none",
                        "reload",
                        "raise_limits",
                        "edit_policy",
                        "use_session_key",
                        "edit_goal",
                        "report_bug"
                      ]
                    }
                  },
                  "attemptId": {
                    "type": "string",
                    "pattern": "^att_[0-7][0-9A-HJKMNP-TV-Z]{25}$"
                  },
                  "runId": {
                    "type": "string",
                    "pattern": "^run_[0-7][0-9A-HJKMNP-TV-Z]{25}$"
                  },
                  "details": {
                    "type": "object",
                    "propertyNames": {
                      "type": "string"
                    },
                    "additionalProperties": {}
                  },
                  "correlationId": {
                    "type": "string",
                    "pattern": "^cor_[0-7][0-9A-HJKMNP-TV-Z]{25}$"
                  }
                },
                "required": [
                  "code",
                  "userMessage",
                  "retryable",
                  "nextAction"
                ]
              },
              {
                "type": "null"
              }
            ]
          }
        },
        "required": [
          "id",
          "stepKey",
          "revisionIndex",
          "retryIndex",
          "state",
          "profileName",
          "providerId",
          "modelId",
          "outcome",
          "outputArtifactId",
          "error"
        ]
      }
    },
    "pendingApproval": {
      "anyOf": [
        {
          "type": "object",
          "properties": {
            "id": {
              "type": "string",
              "pattern": "^apr_[0-7][0-9A-HJKMNP-TV-Z]{25}$"
            },
            "planHash": {
              "type": "string",
              "pattern": "^[a-f0-9]{64}$"
            },
            "contextHash": {
              "type": "string",
              "pattern": "^[a-f0-9]{64}$"
            },
            "fileScope": {
              "type": "array",
              "items": {
                "type": "string",
                "minLength": 1,
                "maxLength": 512
              }
            },
            "providers": {
              "type": "array",
              "items": {
                "type": "string",
                "enum": [
                  "anthropic",
                  "openai",
                  "gemini",
                  "fake"
                ]
              }
            },
            "planArtifactId": {
              "type": "string",
              "pattern": "^art_[0-7][0-9A-HJKMNP-TV-Z]{25}$"
            },
            "decision": {
              "anyOf": [
                {
                  "type": "string",
                  "enum": [
                    "approved",
                    "revision_requested",
                    "rejected"
                  ]
                },
                {
                  "type": "null"
                }
              ]
            },
            "createdAt": {
              "type": "integer",
              "minimum": 0,
              "maximum": 9007199254740991
            }
          },
          "required": [
            "id",
            "planHash",
            "contextHash",
            "fileScope",
            "providers",
            "planArtifactId",
            "decision",
            "createdAt"
          ]
        },
        {
          "type": "null"
        }
      ]
    },
    "unresolvedAttempts": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "id": {
            "type": "string",
            "pattern": "^att_[0-7][0-9A-HJKMNP-TV-Z]{25}$"
          },
          "stepRunId": {
            "type": "string",
            "pattern": "^stp_[0-7][0-9A-HJKMNP-TV-Z]{25}$"
          },
          "stepKey": {
            "type": "string",
            "pattern": "^[a-z][a-z0-9_-]{0,31}$"
          },
          "seq": {
            "type": "integer",
            "exclusiveMinimum": 0,
            "maximum": 9007199254740991
          },
          "purpose": {
            "type": "string",
            "enum": [
              "initial",
              "transport_retry",
              "schema_repair",
              "user_retry",
              "reconcile"
            ]
          },
          "state": {
            "type": "string",
            "enum": [
              "created",
              "reserved",
              "dispatching",
              "succeeded",
              "failed_before_dispatch",
              "failed",
              "unknown",
              "reconciled_succeeded",
              "reconciled_failed",
              "abandoned"
            ]
          },
          "providerId": {
            "type": "string",
            "enum": [
              "anthropic",
              "openai",
              "gemini",
              "fake"
            ]
          },
          "modelId": {
            "type": "string"
          },
          "usage": {
            "anyOf": [
              {
                "type": "object",
                "properties": {
                  "uncachedInputTokens": {
                    "type": "integer",
                    "minimum": 0,
                    "maximum": 9007199254740991
                  },
                  "cacheReadInputTokens": {
                    "type": "integer",
                    "minimum": 0,
                    "maximum": 9007199254740991
                  },
                  "cacheWriteInputTokens": {
                    "type": "integer",
                    "minimum": 0,
                    "maximum": 9007199254740991
                  },
                  "outputTokens": {
                    "type": "integer",
                    "minimum": 0,
                    "maximum": 9007199254740991
                  },
                  "reasoningTokens": {
                    "type": "integer",
                    "minimum": 0,
                    "maximum": 9007199254740991
                  },
                  "partial": {
                    "type": "boolean"
                  }
                },
                "required": [
                  "uncachedInputTokens",
                  "cacheReadInputTokens",
                  "cacheWriteInputTokens",
                  "outputTokens"
                ]
              },
              {
                "type": "null"
              }
            ]
          },
          "cost": {
            "anyOf": [
              {
                "type": "object",
                "properties": {
                  "microusd": {
                    "type": "integer",
                    "minimum": -9007199254740991,
                    "maximum": 9007199254740991
                  },
                  "certainty": {
                    "type": "string",
                    "enum": [
                      "reported",
                      "calculated",
                      "estimated",
                      "unknown"
                    ]
                  }
                },
                "required": [
                  "microusd",
                  "certainty"
                ]
              },
              {
                "type": "null"
              }
            ]
          },
          "providerLatencyMs": {
            "anyOf": [
              {
                "type": "integer",
                "minimum": 0,
                "maximum": 9007199254740991
              },
              {
                "type": "null"
              }
            ]
          },
          "appElapsedMs": {
            "anyOf": [
              {
                "type": "integer",
                "minimum": 0,
                "maximum": 9007199254740991
              },
              {
                "type": "null"
              }
            ]
          },
          "providerRequestId": {
            "type": [
              "string",
              "null"
            ]
          },
          "startedAt": {
            "type": "integer",
            "minimum": 0,
            "maximum": 9007199254740991
          },
          "finishedAt": {
            "anyOf": [
              {
                "type": "integer",
                "minimum": 0,
                "maximum": 9007199254740991
              },
              {
                "type": "null"
              }
            ]
          }
        },
        "required": [
          "id",
          "stepRunId",
          "stepKey",
          "seq",
          "purpose",
          "state",
          "providerId",
          "modelId",
          "usage",
          "cost",
          "providerLatencyMs",
          "appElapsedMs",
          "providerRequestId",
          "startedAt",
          "finishedAt"
        ]
      }
    },
    "executionMsUsed": {
      "type": "integer",
      "minimum": 0,
      "maximum": 9007199254740991
    },
    "revisionCycle": {
      "type": "integer",
      "minimum": -9007199254740991,
      "maximum": 9007199254740991
    },
    "statusDetail": {
      "anyOf": [
        {
          "type": "object",
          "properties": {
            "code": {
              "type": "string",
              "enum": [
                "AUTH_REQUIRED",
                "MODEL_UNSUPPORTED",
                "RATE_LIMITED",
                "BUDGET_BLOCKED",
                "CONTEXT_TOO_LARGE",
                "OUTPUT_INVALID",
                "APPROVAL_STALE",
                "PROJECT_CHANGED",
                "REQUEST_OUTCOME_UNKNOWN",
                "ARTIFACT_WRITE_FAILED",
                "RUNNER_UNAVAILABLE",
                "PROVIDER_UNAVAILABLE",
                "VALIDATION_FAILED",
                "NOT_FOUND",
                "CONFLICT",
                "LIMIT_REACHED",
                "PERMISSION_DENIED",
                "SECURE_STORAGE_UNAVAILABLE",
                "MODEL_REFUSED",
                "INTERNAL"
              ]
            },
            "userMessage": {
              "type": "string",
              "maxLength": 400
            },
            "retryable": {
              "type": "boolean"
            },
            "nextAction": {
              "type": "string",
              "enum": [
                "reconnect_provider",
                "choose_profile",
                "wait",
                "increase_allowance",
                "stop",
                "narrow_scope",
                "retry_step",
                "reapprove",
                "resnapshot_and_replan",
                "use_preserved_snapshot",
                "decide_unknown",
                "retry_export",
                "restart_runner",
                "fix_input",
                "none",
                "reload",
                "raise_limits",
                "edit_policy",
                "use_session_key",
                "edit_goal",
                "report_bug"
              ]
            },
            "alternatives": {
              "default": [],
              "type": "array",
              "items": {
                "type": "string",
                "enum": [
                  "reconnect_provider",
                  "choose_profile",
                  "wait",
                  "increase_allowance",
                  "stop",
                  "narrow_scope",
                  "retry_step",
                  "reapprove",
                  "resnapshot_and_replan",
                  "use_preserved_snapshot",
                  "decide_unknown",
                  "retry_export",
                  "restart_runner",
                  "fix_input",
                  "none",
                  "reload",
                  "raise_limits",
                  "edit_policy",
                  "use_session_key",
                  "edit_goal",
                  "report_bug"
                ]
              }
            },
            "attemptId": {
              "type": "string",
              "pattern": "^att_[0-7][0-9A-HJKMNP-TV-Z]{25}$"
            },
            "runId": {
              "type": "string",
              "pattern": "^run_[0-7][0-9A-HJKMNP-TV-Z]{25}$"
            },
            "details": {
              "type": "object",
              "propertyNames": {
                "type": "string"
              },
              "additionalProperties": {}
            },
            "correlationId": {
              "type": "string",
              "pattern": "^cor_[0-7][0-9A-HJKMNP-TV-Z]{25}$"
            }
          },
          "required": [
            "code",
            "userMessage",
            "retryable",
            "nextAction"
          ]
        },
        {
          "type": "null"
        }
      ]
    },
    "reportArtifactId": {
      "anyOf": [
        {
          "type": "string",
          "pattern": "^art_[0-7][0-9A-HJKMNP-TV-Z]{25}$"
        },
        {
          "type": "null"
        }
      ]
    },
    "availableActions": {
      "type": "array",
      "items": {
        "type": "string",
        "enum": [
          "pause",
          "cancel",
          "stop",
          "resume",
          "approve",
          "request_revision",
          "reject",
          "increase_allowance",
          "edit_project_allowance",
          "choose_profile",
          "retry_step",
          "raise_limits",
          "acknowledge_overrun",
          "reconnect_provider",
          "resnapshot_and_replan",
          "use_preserved_snapshot",
          "decide_unknown",
          "review_recovery",
          "export_report",
          "export_patch"
        ]
      }
    }
  },
  "required": [
    "id",
    "projectId",
    "goal",
    "workflow",
    "status",
    "pauseReason",
    "stepProgress",
    "cost",
    "createdAt",
    "startedAt",
    "endedAt",
    "limits",
    "input",
    "contextHash",
    "steps",
    "pendingApproval",
    "unresolvedAttempts",
    "executionMsUsed",
    "revisionCycle",
    "statusDetail",
    "reportArtifactId",
    "availableActions"
  ]
}
```

## `runs.getStep`

Channel `relay/v1/runs.getStep` · query · route `runner`

### Input

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "runId": {
      "type": "string",
      "pattern": "^run_[0-7][0-9A-HJKMNP-TV-Z]{25}$"
    },
    "stepId": {
      "type": "string",
      "pattern": "^stp_[0-7][0-9A-HJKMNP-TV-Z]{25}$"
    }
  },
  "required": [
    "runId",
    "stepId"
  ]
}
```

### Output

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "step": {
      "type": "object",
      "properties": {
        "id": {
          "type": "string",
          "pattern": "^stp_[0-7][0-9A-HJKMNP-TV-Z]{25}$"
        },
        "stepKey": {
          "type": "string",
          "pattern": "^[a-z][a-z0-9_-]{0,31}$"
        },
        "revisionIndex": {
          "type": "integer",
          "minimum": 0,
          "maximum": 9007199254740991
        },
        "retryIndex": {
          "type": "integer",
          "minimum": 0,
          "maximum": 9007199254740991
        },
        "state": {
          "type": "string",
          "enum": [
            "pending",
            "ready",
            "reserved",
            "executing",
            "validating",
            "awaiting_approval",
            "succeeded",
            "failed",
            "unknown",
            "skipped"
          ]
        },
        "profileName": {
          "type": [
            "string",
            "null"
          ]
        },
        "providerId": {
          "anyOf": [
            {
              "type": "string",
              "enum": [
                "anthropic",
                "openai",
                "gemini",
                "fake"
              ]
            },
            {
              "type": "null"
            }
          ]
        },
        "modelId": {
          "type": [
            "string",
            "null"
          ]
        },
        "outcome": {
          "type": [
            "string",
            "null"
          ]
        },
        "outputArtifactId": {
          "anyOf": [
            {
              "type": "string",
              "pattern": "^art_[0-7][0-9A-HJKMNP-TV-Z]{25}$"
            },
            {
              "type": "null"
            }
          ]
        },
        "error": {
          "anyOf": [
            {
              "type": "object",
              "properties": {
                "code": {
                  "type": "string",
                  "enum": [
                    "AUTH_REQUIRED",
                    "MODEL_UNSUPPORTED",
                    "RATE_LIMITED",
                    "BUDGET_BLOCKED",
                    "CONTEXT_TOO_LARGE",
                    "OUTPUT_INVALID",
                    "APPROVAL_STALE",
                    "PROJECT_CHANGED",
                    "REQUEST_OUTCOME_UNKNOWN",
                    "ARTIFACT_WRITE_FAILED",
                    "RUNNER_UNAVAILABLE",
                    "PROVIDER_UNAVAILABLE",
                    "VALIDATION_FAILED",
                    "NOT_FOUND",
                    "CONFLICT",
                    "LIMIT_REACHED",
                    "PERMISSION_DENIED",
                    "SECURE_STORAGE_UNAVAILABLE",
                    "MODEL_REFUSED",
                    "INTERNAL"
                  ]
                },
                "userMessage": {
                  "type": "string",
                  "maxLength": 400
                },
                "retryable": {
                  "type": "boolean"
                },
                "nextAction": {
                  "type": "string",
                  "enum": [
                    "reconnect_provider",
                    "choose_profile",
                    "wait",
                    "increase_allowance",
                    "stop",
                    "narrow_scope",
                    "retry_step",
                    "reapprove",
                    "resnapshot_and_replan",
                    "use_preserved_snapshot",
                    "decide_unknown",
                    "retry_export",
                    "restart_runner",
                    "fix_input",
                    "none",
                    "reload",
                    "raise_limits",
                    "edit_policy",
                    "use_session_key",
                    "edit_goal",
                    "report_bug"
                  ]
                },
                "alternatives": {
                  "default": [],
                  "type": "array",
                  "items": {
                    "type": "string",
                    "enum": [
                      "reconnect_provider",
                      "choose_profile",
                      "wait",
                      "increase_allowance",
                      "stop",
                      "narrow_scope",
                      "retry_step",
                      "reapprove",
                      "resnapshot_and_replan",
                      "use_preserved_snapshot",
                      "decide_unknown",
                      "retry_export",
                      "restart_runner",
                      "fix_input",
                      "none",
                      "reload",
                      "raise_limits",
                      "edit_policy",
                      "use_session_key",
                      "edit_goal",
                      "report_bug"
                    ]
                  }
                },
                "attemptId": {
                  "type": "string",
                  "pattern": "^att_[0-7][0-9A-HJKMNP-TV-Z]{25}$"
                },
                "runId": {
                  "type": "string",
                  "pattern": "^run_[0-7][0-9A-HJKMNP-TV-Z]{25}$"
                },
                "details": {
                  "type": "object",
                  "propertyNames": {
                    "type": "string"
                  },
                  "additionalProperties": {}
                },
                "correlationId": {
                  "type": "string",
                  "pattern": "^cor_[0-7][0-9A-HJKMNP-TV-Z]{25}$"
                }
              },
              "required": [
                "code",
                "userMessage",
                "retryable",
                "nextAction"
              ]
            },
            {
              "type": "null"
            }
          ]
        }
      },
      "required": [
        "id",
        "stepKey",
        "revisionIndex",
        "retryIndex",
        "state",
        "profileName",
        "providerId",
        "modelId",
        "outcome",
        "outputArtifactId",
        "error"
      ]
    },
    "output": {
      "anyOf": [
        {
          "oneOf": [
            {
              "type": "object",
              "properties": {
                "schemaId": {
                  "type": "string",
                  "const": "findings.v1"
                },
                "value": {
                  "type": "object",
                  "properties": {
                    "summary": {
                      "type": "string",
                      "minLength": 1,
                      "maxLength": 1200
                    },
                    "sourceRefs": {
                      "maxItems": 50,
                      "type": "array",
                      "items": {
                        "type": "object",
                        "properties": {
                          "relPath": {
                            "type": "string"
                          },
                          "startLine": {
                            "anyOf": [
                              {
                                "type": "integer",
                                "exclusiveMinimum": 0,
                                "maximum": 9007199254740991
                              },
                              {
                                "type": "null"
                              }
                            ]
                          },
                          "endLine": {
                            "anyOf": [
                              {
                                "type": "integer",
                                "exclusiveMinimum": 0,
                                "maximum": 9007199254740991
                              },
                              {
                                "type": "null"
                              }
                            ]
                          }
                        },
                        "required": [
                          "relPath",
                          "startLine",
                          "endLine"
                        ]
                      }
                    },
                    "unresolvedQuestions": {
                      "maxItems": 10,
                      "type": "array",
                      "items": {
                        "type": "string",
                        "maxLength": 400
                      }
                    },
                    "outcome": {
                      "type": "string",
                      "enum": [
                        "findings",
                        "no_issues"
                      ]
                    },
                    "findings": {
                      "maxItems": 20,
                      "type": "array",
                      "items": {
                        "type": "object",
                        "properties": {
                          "id": {
                            "type": "string",
                            "pattern": "^F\\d{1,2}$"
                          },
                          "title": {
                            "type": "string"
                          },
                          "severity": {
                            "type": "string",
                            "enum": [
                              "high",
                              "medium",
                              "low",
                              "info"
                            ]
                          },
                          "category": {
                            "type": "string",
                            "enum": [
                              "correctness",
                              "validation",
                              "error_handling",
                              "docs",
                              "style",
                              "security"
                            ]
                          },
                          "description": {
                            "type": "string"
                          },
                          "sourceRefs": {
                            "minItems": 1,
                            "type": "array",
                            "items": {
                              "type": "object",
                              "properties": {
                                "relPath": {
                                  "type": "string"
                                },
                                "startLine": {
                                  "anyOf": [
                                    {
                                      "type": "integer",
                                      "exclusiveMinimum": 0,
                                      "maximum": 9007199254740991
                                    },
                                    {
                                      "type": "null"
                                    }
                                  ]
                                },
                                "endLine": {
                                  "anyOf": [
                                    {
                                      "type": "integer",
                                      "exclusiveMinimum": 0,
                                      "maximum": 9007199254740991
                                    },
                                    {
                                      "type": "null"
                                    }
                                  ]
                                }
                              },
                              "required": [
                                "relPath",
                                "startLine",
                                "endLine"
                              ]
                            }
                          }
                        },
                        "required": [
                          "id",
                          "title",
                          "severity",
                          "category",
                          "description",
                          "sourceRefs"
                        ]
                      }
                    }
                  },
                  "required": [
                    "summary",
                    "sourceRefs",
                    "unresolvedQuestions",
                    "outcome",
                    "findings"
                  ]
                }
              },
              "required": [
                "schemaId",
                "value"
              ]
            },
            {
              "type": "object",
              "properties": {
                "schemaId": {
                  "type": "string",
                  "const": "plan.v1"
                },
                "value": {
                  "type": "object",
                  "properties": {
                    "summary": {
                      "type": "string",
                      "minLength": 1,
                      "maxLength": 1200
                    },
                    "sourceRefs": {
                      "maxItems": 50,
                      "type": "array",
                      "items": {
                        "type": "object",
                        "properties": {
                          "relPath": {
                            "type": "string"
                          },
                          "startLine": {
                            "anyOf": [
                              {
                                "type": "integer",
                                "exclusiveMinimum": 0,
                                "maximum": 9007199254740991
                              },
                              {
                                "type": "null"
                              }
                            ]
                          },
                          "endLine": {
                            "anyOf": [
                              {
                                "type": "integer",
                                "exclusiveMinimum": 0,
                                "maximum": 9007199254740991
                              },
                              {
                                "type": "null"
                              }
                            ]
                          }
                        },
                        "required": [
                          "relPath",
                          "startLine",
                          "endLine"
                        ]
                      }
                    },
                    "unresolvedQuestions": {
                      "maxItems": 10,
                      "type": "array",
                      "items": {
                        "type": "string",
                        "maxLength": 400
                      }
                    },
                    "outcome": {
                      "type": "string",
                      "const": "plan"
                    },
                    "goalRestatement": {
                      "type": "string"
                    },
                    "steps": {
                      "minItems": 1,
                      "maxItems": 12,
                      "type": "array",
                      "items": {
                        "type": "object",
                        "properties": {
                          "n": {
                            "type": "integer",
                            "exclusiveMinimum": 0,
                            "maximum": 9007199254740991
                          },
                          "action": {
                            "type": "string"
                          },
                          "rationale": {
                            "type": "string"
                          },
                          "findingIds": {
                            "type": "array",
                            "items": {
                              "type": "string"
                            }
                          }
                        },
                        "required": [
                          "n",
                          "action",
                          "rationale",
                          "findingIds"
                        ]
                      }
                    },
                    "fileScope": {
                      "minItems": 1,
                      "maxItems": 20,
                      "type": "array",
                      "items": {
                        "type": "string"
                      }
                    },
                    "testSuggestions": {
                      "maxItems": 10,
                      "type": "array",
                      "items": {
                        "type": "string"
                      }
                    },
                    "risks": {
                      "type": "array",
                      "items": {
                        "type": "string"
                      }
                    },
                    "decisions": {
                      "maxItems": 3,
                      "type": "array",
                      "items": {
                        "type": "object",
                        "properties": {
                          "title": {
                            "type": "string"
                          },
                          "content": {
                            "type": "string"
                          }
                        },
                        "required": [
                          "title",
                          "content"
                        ]
                      }
                    }
                  },
                  "required": [
                    "summary",
                    "sourceRefs",
                    "unresolvedQuestions",
                    "outcome",
                    "goalRestatement",
                    "steps",
                    "fileScope",
                    "testSuggestions",
                    "risks",
                    "decisions"
                  ]
                }
              },
              "required": [
                "schemaId",
                "value"
              ]
            },
            {
              "type": "object",
              "properties": {
                "schemaId": {
                  "type": "string",
                  "const": "patch.v1"
                },
                "value": {
                  "type": "object",
                  "properties": {
                    "summary": {
                      "type": "string",
                      "minLength": 1,
                      "maxLength": 1200
                    },
                    "sourceRefs": {
                      "maxItems": 50,
                      "type": "array",
                      "items": {
                        "type": "object",
                        "properties": {
                          "relPath": {
                            "type": "string"
                          },
                          "startLine": {
                            "anyOf": [
                              {
                                "type": "integer",
                                "exclusiveMinimum": 0,
                                "maximum": 9007199254740991
                              },
                              {
                                "type": "null"
                              }
                            ]
                          },
                          "endLine": {
                            "anyOf": [
                              {
                                "type": "integer",
                                "exclusiveMinimum": 0,
                                "maximum": 9007199254740991
                              },
                              {
                                "type": "null"
                              }
                            ]
                          }
                        },
                        "required": [
                          "relPath",
                          "startLine",
                          "endLine"
                        ]
                      }
                    },
                    "unresolvedQuestions": {
                      "maxItems": 10,
                      "type": "array",
                      "items": {
                        "type": "string",
                        "maxLength": 400
                      }
                    },
                    "outcome": {
                      "type": "string",
                      "const": "patch"
                    },
                    "files": {
                      "minItems": 1,
                      "maxItems": 20,
                      "type": "array",
                      "items": {
                        "type": "object",
                        "properties": {
                          "relPath": {
                            "type": "string"
                          },
                          "changeType": {
                            "type": "string",
                            "enum": [
                              "modify",
                              "delete"
                            ]
                          },
                          "unifiedDiff": {
                            "type": "string"
                          }
                        },
                        "required": [
                          "relPath",
                          "changeType",
                          "unifiedDiff"
                        ]
                      }
                    },
                    "testSuggestions": {
                      "type": "array",
                      "items": {
                        "type": "object",
                        "properties": {
                          "relPath": {
                            "type": [
                              "string",
                              "null"
                            ]
                          },
                          "description": {
                            "type": "string"
                          }
                        },
                        "required": [
                          "relPath",
                          "description"
                        ]
                      }
                    },
                    "notes": {
                      "type": "string"
                    }
                  },
                  "required": [
                    "summary",
                    "sourceRefs",
                    "unresolvedQuestions",
                    "outcome",
                    "files",
                    "testSuggestions",
                    "notes"
                  ]
                }
              },
              "required": [
                "schemaId",
                "value"
              ]
            },
            {
              "type": "object",
              "properties": {
                "schemaId": {
                  "type": "string",
                  "const": "review.v1"
                },
                "value": {
                  "type": "object",
                  "properties": {
                    "summary": {
                      "type": "string",
                      "minLength": 1,
                      "maxLength": 1200
                    },
                    "sourceRefs": {
                      "maxItems": 50,
                      "type": "array",
                      "items": {
                        "type": "object",
                        "properties": {
                          "relPath": {
                            "type": "string"
                          },
                          "startLine": {
                            "anyOf": [
                              {
                                "type": "integer",
                                "exclusiveMinimum": 0,
                                "maximum": 9007199254740991
                              },
                              {
                                "type": "null"
                              }
                            ]
                          },
                          "endLine": {
                            "anyOf": [
                              {
                                "type": "integer",
                                "exclusiveMinimum": 0,
                                "maximum": 9007199254740991
                              },
                              {
                                "type": "null"
                              }
                            ]
                          }
                        },
                        "required": [
                          "relPath",
                          "startLine",
                          "endLine"
                        ]
                      }
                    },
                    "unresolvedQuestions": {
                      "maxItems": 10,
                      "type": "array",
                      "items": {
                        "type": "string",
                        "maxLength": 400
                      }
                    },
                    "outcome": {
                      "type": "string",
                      "enum": [
                        "accept",
                        "revise",
                        "incomplete"
                      ]
                    },
                    "verdictRationale": {
                      "type": "string"
                    },
                    "requestedChanges": {
                      "maxItems": 10,
                      "type": "array",
                      "items": {
                        "type": "object",
                        "properties": {
                          "relPath": {
                            "type": "string"
                          },
                          "description": {
                            "type": "string"
                          }
                        },
                        "required": [
                          "relPath",
                          "description"
                        ]
                      }
                    },
                    "checks": {
                      "type": "array",
                      "items": {
                        "type": "object",
                        "properties": {
                          "name": {
                            "type": "string"
                          },
                          "passed": {
                            "type": "boolean"
                          },
                          "detail": {
                            "type": "string"
                          }
                        },
                        "required": [
                          "name",
                          "passed",
                          "detail"
                        ]
                      }
                    },
                    "memoryProposals": {
                      "maxItems": 3,
                      "type": "array",
                      "items": {
                        "type": "object",
                        "properties": {
                          "title": {
                            "type": "string"
                          },
                          "content": {
                            "type": "string"
                          },
                          "type": {
                            "type": "string",
                            "enum": [
                              "user_rule",
                              "project_decision"
                            ]
                          },
                          "rationale": {
                            "type": "string"
                          },
                          "conflictsWith": {
                            "type": "array",
                            "items": {
                              "type": "string"
                            }
                          }
                        },
                        "required": [
                          "title",
                          "content",
                          "type",
                          "rationale",
                          "conflictsWith"
                        ]
                      }
                    }
                  },
                  "required": [
                    "summary",
                    "sourceRefs",
                    "unresolvedQuestions",
                    "outcome",
                    "verdictRationale",
                    "requestedChanges",
                    "checks",
                    "memoryProposals"
                  ]
                }
              },
              "required": [
                "schemaId",
                "value"
              ]
            },
            {
              "type": "object",
              "properties": {
                "schemaId": {
                  "type": "string",
                  "const": "report.v1"
                },
                "value": {
                  "type": "object",
                  "properties": {
                    "schemaId": {
                      "type": "string",
                      "const": "report.v1"
                    },
                    "runId": {
                      "type": "string",
                      "pattern": "^run_[0-7][0-9A-HJKMNP-TV-Z]{25}$"
                    },
                    "projectId": {
                      "type": "string",
                      "pattern": "^prj_[0-7][0-9A-HJKMNP-TV-Z]{25}$"
                    },
                    "goal": {
                      "type": "string"
                    },
                    "status": {
                      "type": "string",
                      "enum": [
                        "completed",
                        "incomplete",
                        "cancelled",
                        "failed"
                      ]
                    },
                    "verdict": {
                      "anyOf": [
                        {
                          "type": "string",
                          "enum": [
                            "accept",
                            "revise",
                            "incomplete"
                          ]
                        },
                        {
                          "type": "null"
                        }
                      ]
                    },
                    "workflow": {
                      "type": "object",
                      "properties": {
                        "id": {
                          "type": "string",
                          "pattern": "^wfl_[0-7][0-9A-HJKMNP-TV-Z]{25}$"
                        },
                        "version": {
                          "type": "integer",
                          "exclusiveMinimum": 0,
                          "maximum": 9007199254740991
                        },
                        "contentHash": {
                          "type": "string",
                          "pattern": "^[a-f0-9]{64}$"
                        }
                      },
                      "required": [
                        "id",
                        "version",
                        "contentHash"
                      ]
                    },
                    "steps": {
                      "type": "array",
                      "items": {
                        "type": "object",
                        "properties": {
                          "stepKey": {
                            "type": "string",
                            "pattern": "^[a-z][a-z0-9_-]{0,31}$"
                          },
                          "revisionIndex": {
                            "type": "integer",
                            "minimum": 0,
                            "maximum": 9007199254740991
                          },
                          "retryIndex": {
                            "type": "integer",
                            "minimum": 0,
                            "maximum": 9007199254740991
                          },
                          "state": {
                            "type": "string",
                            "enum": [
                              "pending",
                              "ready",
                              "reserved",
                              "executing",
                              "validating",
                              "awaiting_approval",
                              "succeeded",
                              "failed",
                              "unknown",
                              "skipped"
                            ]
                          },
                          "profileName": {
                            "type": [
                              "string",
                              "null"
                            ]
                          },
                          "providerId": {
                            "anyOf": [
                              {
                                "type": "string",
                                "enum": [
                                  "anthropic",
                                  "openai",
                                  "gemini",
                                  "fake"
                                ]
                              },
                              {
                                "type": "null"
                              }
                            ]
                          },
                          "modelId": {
                            "type": [
                              "string",
                              "null"
                            ]
                          },
                          "cost": {
                            "type": "object",
                            "properties": {
                              "settledMicrousd": {
                                "type": "integer",
                                "minimum": -9007199254740991,
                                "maximum": 9007199254740991
                              },
                              "certainty": {
                                "type": "string",
                                "enum": [
                                  "reported",
                                  "calculated",
                                  "estimated",
                                  "unknown"
                                ]
                              },
                              "unknownMicrousd": {
                                "type": "integer",
                                "minimum": -9007199254740991,
                                "maximum": 9007199254740991
                              }
                            },
                            "required": [
                              "settledMicrousd",
                              "certainty",
                              "unknownMicrousd"
                            ]
                          }
                        },
                        "required": [
                          "stepKey",
                          "revisionIndex",
                          "retryIndex",
                          "state",
                          "profileName",
                          "providerId",
                          "modelId",
                          "cost"
                        ]
                      }
                    },
                    "totals": {
                      "type": "object",
                      "properties": {
                        "allowance": {
                          "type": "integer",
                          "minimum": -9007199254740991,
                          "maximum": 9007199254740991
                        },
                        "settledReported": {
                          "type": "integer",
                          "minimum": -9007199254740991,
                          "maximum": 9007199254740991
                        },
                        "settledCalculated": {
                          "type": "integer",
                          "minimum": -9007199254740991,
                          "maximum": 9007199254740991
                        },
                        "settledEstimated": {
                          "type": "integer",
                          "minimum": -9007199254740991,
                          "maximum": 9007199254740991
                        },
                        "reserved": {
                          "type": "integer",
                          "minimum": -9007199254740991,
                          "maximum": 9007199254740991
                        },
                        "unknown": {
                          "type": "integer",
                          "minimum": -9007199254740991,
                          "maximum": 9007199254740991
                        },
                        "remaining": {
                          "type": "integer",
                          "minimum": -9007199254740991,
                          "maximum": 9007199254740991
                        },
                        "overrun": {
                          "type": "boolean"
                        }
                      },
                      "required": [
                        "allowance",
                        "settledReported",
                        "settledCalculated",
                        "settledEstimated",
                        "reserved",
                        "unknown",
                        "remaining",
                        "overrun"
                      ]
                    },
                    "unknownLiabilities": {
                      "type": "array",
                      "items": {
                        "type": "object",
                        "properties": {
                          "attemptId": {
                            "type": "string",
                            "pattern": "^att_[0-7][0-9A-HJKMNP-TV-Z]{25}$"
                          },
                          "stepKey": {
                            "type": "string",
                            "pattern": "^[a-z][a-z0-9_-]{0,31}$"
                          },
                          "liabilityMicrousd": {
                            "type": "integer",
                            "minimum": -9007199254740991,
                            "maximum": 9007199254740991
                          },
                          "state": {
                            "type": "string",
                            "enum": [
                              "unknown",
                              "abandoned"
                            ]
                          }
                        },
                        "required": [
                          "attemptId",
                          "stepKey",
                          "liabilityMicrousd",
                          "state"
                        ]
                      }
                    },
                    "artifacts": {
                      "type": "object",
                      "properties": {
                        "findings": {
                          "anyOf": [
                            {
                              "type": "string",
                              "pattern": "^art_[0-7][0-9A-HJKMNP-TV-Z]{25}$"
                            },
                            {
                              "type": "null"
                            }
                          ]
                        },
                        "plan": {
                          "anyOf": [
                            {
                              "type": "string",
                              "pattern": "^art_[0-7][0-9A-HJKMNP-TV-Z]{25}$"
                            },
                            {
                              "type": "null"
                            }
                          ]
                        },
                        "patch": {
                          "anyOf": [
                            {
                              "type": "string",
                              "pattern": "^art_[0-7][0-9A-HJKMNP-TV-Z]{25}$"
                            },
                            {
                              "type": "null"
                            }
                          ]
                        },
                        "review": {
                          "anyOf": [
                            {
                              "type": "string",
                              "pattern": "^art_[0-7][0-9A-HJKMNP-TV-Z]{25}$"
                            },
                            {
                              "type": "null"
                            }
                          ]
                        }
                      },
                      "required": [
                        "findings",
                        "plan",
                        "patch",
                        "review"
                      ]
                    },
                    "limitations": {
                      "type": "array",
                      "items": {
                        "type": "string",
                        "maxLength": 600
                      }
                    },
                    "snapshotUsed": {
                      "type": "boolean"
                    },
                    "generatedAt": {
                      "type": "integer",
                      "minimum": 0,
                      "maximum": 9007199254740991
                    },
                    "approvals": {
                      "type": "array",
                      "items": {
                        "type": "object",
                        "properties": {
                          "approvalId": {
                            "type": "string",
                            "pattern": "^apr_[0-7][0-9A-HJKMNP-TV-Z]{25}$"
                          },
                          "stepKey": {
                            "type": "string",
                            "pattern": "^[a-z][a-z0-9_-]{0,31}$"
                          },
                          "planArtifactId": {
                            "type": "string",
                            "pattern": "^art_[0-7][0-9A-HJKMNP-TV-Z]{25}$"
                          },
                          "planHash": {
                            "type": "string",
                            "pattern": "^[a-f0-9]{64}$"
                          },
                          "decision": {
                            "anyOf": [
                              {
                                "type": "string",
                                "enum": [
                                  "approved",
                                  "revision_requested",
                                  "rejected"
                                ]
                              },
                              {
                                "type": "null"
                              }
                            ]
                          },
                          "decidedAt": {
                            "anyOf": [
                              {
                                "type": "integer",
                                "minimum": 0,
                                "maximum": 9007199254740991
                              },
                              {
                                "type": "null"
                              }
                            ]
                          },
                          "note": {
                            "anyOf": [
                              {
                                "type": "string",
                                "maxLength": 2000
                              },
                              {
                                "type": "null"
                              }
                            ]
                          },
                          "invalidatedReason": {
                            "anyOf": [
                              {
                                "type": "string",
                                "enum": [
                                  "plan_changed",
                                  "scope_changed",
                                  "project_changed",
                                  "provider_changed"
                                ]
                              },
                              {
                                "type": "null"
                              }
                            ]
                          },
                          "createdAt": {
                            "type": "integer",
                            "minimum": 0,
                            "maximum": 9007199254740991
                          }
                        },
                        "required": [
                          "approvalId",
                          "stepKey",
                          "planArtifactId",
                          "planHash",
                          "decision",
                          "decidedAt",
                          "note",
                          "invalidatedReason",
                          "createdAt"
                        ]
                      }
                    },
                    "revisions": {
                      "type": "object",
                      "properties": {
                        "cycles": {
                          "type": "integer",
                          "minimum": 0,
                          "maximum": 9007199254740991
                        },
                        "maxCycles": {
                          "type": "integer",
                          "minimum": 0,
                          "maximum": 9007199254740991
                        },
                        "planRevisions": {
                          "type": "integer",
                          "minimum": 0,
                          "maximum": 9007199254740991
                        },
                        "incompleteCause": {
                          "anyOf": [
                            {
                              "type": "string",
                              "enum": [
                                "revision_limit",
                                "verifier_incomplete"
                              ]
                            },
                            {
                              "type": "null"
                            }
                          ]
                        }
                      },
                      "required": [
                        "cycles",
                        "maxCycles",
                        "planRevisions",
                        "incompleteCause"
                      ]
                    }
                  },
                  "required": [
                    "schemaId",
                    "runId",
                    "projectId",
                    "goal",
                    "status",
                    "verdict",
                    "workflow",
                    "steps",
                    "totals",
                    "unknownLiabilities",
                    "artifacts",
                    "limitations",
                    "snapshotUsed",
                    "generatedAt"
                  ]
                }
              },
              "required": [
                "schemaId",
                "value"
              ]
            }
          ]
        },
        {
          "type": "null"
        }
      ]
    },
    "manifest": {
      "anyOf": [
        {
          "type": "object",
          "properties": {
            "schemaVersion": {
              "type": "number",
              "const": 1
            },
            "runId": {
              "type": "string",
              "pattern": "^run_[0-7][0-9A-HJKMNP-TV-Z]{25}$"
            },
            "stepKey": {
              "type": "string",
              "pattern": "^[a-z][a-z0-9_-]{0,31}$"
            },
            "revisionIndex": {
              "type": "integer",
              "minimum": -9007199254740991,
              "maximum": 9007199254740991
            },
            "attemptPurpose": {
              "type": "string",
              "enum": [
                "initial",
                "transport_retry",
                "schema_repair",
                "user_retry",
                "reconcile"
              ]
            },
            "profile": {
              "type": "object",
              "properties": {
                "name": {
                  "type": "string"
                },
                "providerId": {
                  "type": "string",
                  "enum": [
                    "anthropic",
                    "openai",
                    "gemini",
                    "fake"
                  ]
                },
                "modelId": {
                  "type": "string"
                }
              },
              "required": [
                "name",
                "providerId",
                "modelId"
              ]
            },
            "priceCatalogVersion": {
              "type": "string"
            },
            "instructions": {
              "type": "object",
              "properties": {
                "version": {
                  "type": "string"
                },
                "sha256": {
                  "type": "string",
                  "pattern": "^[a-f0-9]{64}$"
                }
              },
              "required": [
                "version",
                "sha256"
              ]
            },
            "files": {
              "type": "array",
              "items": {
                "type": "object",
                "properties": {
                  "relPath": {
                    "type": "string",
                    "minLength": 1,
                    "maxLength": 512
                  },
                  "sha256": {
                    "type": "string",
                    "pattern": "^[a-f0-9]{64}$"
                  },
                  "sizeBytes": {
                    "type": "number"
                  },
                  "tokens": {
                    "type": "number"
                  },
                  "included": {
                    "type": "boolean"
                  },
                  "reason": {
                    "type": "string",
                    "enum": [
                      "selected",
                      "plan_scope",
                      "referenced_by_findings"
                    ]
                  }
                },
                "required": [
                  "relPath",
                  "sha256",
                  "sizeBytes",
                  "tokens",
                  "included",
                  "reason"
                ]
              }
            },
            "memory": {
              "type": "array",
              "items": {
                "type": "object",
                "properties": {
                  "recordId": {
                    "type": "string",
                    "pattern": "^mem_[0-7][0-9A-HJKMNP-TV-Z]{25}$"
                  },
                  "revision": {
                    "type": "number"
                  },
                  "type": {
                    "type": "string",
                    "enum": [
                      "user_rule",
                      "project_decision",
                      "source_reference",
                      "run_summary"
                    ]
                  },
                  "included": {
                    "type": "boolean"
                  },
                  "pinned": {
                    "type": "boolean"
                  },
                  "stale": {
                    "type": "boolean"
                  },
                  "score": {
                    "type": "number"
                  }
                },
                "required": [
                  "recordId",
                  "revision",
                  "type",
                  "included",
                  "pinned",
                  "stale",
                  "score"
                ]
              }
            },
            "upstream": {
              "type": "array",
              "items": {
                "type": "object",
                "properties": {
                  "stepKey": {
                    "type": "string",
                    "pattern": "^[a-z][a-z0-9_-]{0,31}$"
                  },
                  "artifactId": {
                    "type": "string",
                    "pattern": "^art_[0-7][0-9A-HJKMNP-TV-Z]{25}$"
                  },
                  "schemaId": {
                    "type": "string",
                    "enum": [
                      "findings.v1",
                      "plan.v1",
                      "patch.v1",
                      "review.v1",
                      "report.v1"
                    ]
                  },
                  "sha256": {
                    "type": "string",
                    "pattern": "^[a-f0-9]{64}$"
                  }
                },
                "required": [
                  "stepKey",
                  "artifactId",
                  "schemaId",
                  "sha256"
                ]
              }
            },
            "omitted": {
              "type": "array",
              "items": {
                "type": "object",
                "properties": {
                  "kind": {
                    "type": "string",
                    "enum": [
                      "file",
                      "memory"
                    ]
                  },
                  "ref": {
                    "type": "string"
                  },
                  "reason": {
                    "type": "string",
                    "enum": [
                      "token_budget",
                      "excluded_by_policy",
                      "stale_source"
                    ]
                  }
                },
                "required": [
                  "kind",
                  "ref",
                  "reason"
                ]
              }
            },
            "tokens": {
              "type": "object",
              "properties": {
                "estimatedInput": {
                  "type": "number"
                },
                "budget": {
                  "type": "number"
                },
                "basis": {
                  "type": "string",
                  "enum": [
                    "provider_count",
                    "local_estimate"
                  ]
                }
              },
              "required": [
                "estimatedInput",
                "budget",
                "basis"
              ]
            },
            "contextHash": {
              "type": "string",
              "pattern": "^[a-f0-9]{64}$"
            },
            "providersReceivingContext": {
              "type": "array",
              "items": {
                "type": "string",
                "enum": [
                  "anthropic",
                  "openai",
                  "gemini",
                  "fake"
                ]
              }
            }
          },
          "required": [
            "schemaVersion",
            "runId",
            "stepKey",
            "revisionIndex",
            "attemptPurpose",
            "profile",
            "priceCatalogVersion",
            "instructions",
            "files",
            "memory",
            "upstream",
            "omitted",
            "tokens",
            "contextHash",
            "providersReceivingContext"
          ]
        },
        {
          "type": "null"
        }
      ]
    },
    "attempts": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "id": {
            "type": "string",
            "pattern": "^att_[0-7][0-9A-HJKMNP-TV-Z]{25}$"
          },
          "stepRunId": {
            "type": "string",
            "pattern": "^stp_[0-7][0-9A-HJKMNP-TV-Z]{25}$"
          },
          "stepKey": {
            "type": "string",
            "pattern": "^[a-z][a-z0-9_-]{0,31}$"
          },
          "seq": {
            "type": "integer",
            "exclusiveMinimum": 0,
            "maximum": 9007199254740991
          },
          "purpose": {
            "type": "string",
            "enum": [
              "initial",
              "transport_retry",
              "schema_repair",
              "user_retry",
              "reconcile"
            ]
          },
          "state": {
            "type": "string",
            "enum": [
              "created",
              "reserved",
              "dispatching",
              "succeeded",
              "failed_before_dispatch",
              "failed",
              "unknown",
              "reconciled_succeeded",
              "reconciled_failed",
              "abandoned"
            ]
          },
          "providerId": {
            "type": "string",
            "enum": [
              "anthropic",
              "openai",
              "gemini",
              "fake"
            ]
          },
          "modelId": {
            "type": "string"
          },
          "usage": {
            "anyOf": [
              {
                "type": "object",
                "properties": {
                  "uncachedInputTokens": {
                    "type": "integer",
                    "minimum": 0,
                    "maximum": 9007199254740991
                  },
                  "cacheReadInputTokens": {
                    "type": "integer",
                    "minimum": 0,
                    "maximum": 9007199254740991
                  },
                  "cacheWriteInputTokens": {
                    "type": "integer",
                    "minimum": 0,
                    "maximum": 9007199254740991
                  },
                  "outputTokens": {
                    "type": "integer",
                    "minimum": 0,
                    "maximum": 9007199254740991
                  },
                  "reasoningTokens": {
                    "type": "integer",
                    "minimum": 0,
                    "maximum": 9007199254740991
                  },
                  "partial": {
                    "type": "boolean"
                  }
                },
                "required": [
                  "uncachedInputTokens",
                  "cacheReadInputTokens",
                  "cacheWriteInputTokens",
                  "outputTokens"
                ]
              },
              {
                "type": "null"
              }
            ]
          },
          "cost": {
            "anyOf": [
              {
                "type": "object",
                "properties": {
                  "microusd": {
                    "type": "integer",
                    "minimum": -9007199254740991,
                    "maximum": 9007199254740991
                  },
                  "certainty": {
                    "type": "string",
                    "enum": [
                      "reported",
                      "calculated",
                      "estimated",
                      "unknown"
                    ]
                  }
                },
                "required": [
                  "microusd",
                  "certainty"
                ]
              },
              {
                "type": "null"
              }
            ]
          },
          "providerLatencyMs": {
            "anyOf": [
              {
                "type": "integer",
                "minimum": 0,
                "maximum": 9007199254740991
              },
              {
                "type": "null"
              }
            ]
          },
          "appElapsedMs": {
            "anyOf": [
              {
                "type": "integer",
                "minimum": 0,
                "maximum": 9007199254740991
              },
              {
                "type": "null"
              }
            ]
          },
          "providerRequestId": {
            "type": [
              "string",
              "null"
            ]
          },
          "startedAt": {
            "type": "integer",
            "minimum": 0,
            "maximum": 9007199254740991
          },
          "finishedAt": {
            "anyOf": [
              {
                "type": "integer",
                "minimum": 0,
                "maximum": 9007199254740991
              },
              {
                "type": "null"
              }
            ]
          }
        },
        "required": [
          "id",
          "stepRunId",
          "stepKey",
          "seq",
          "purpose",
          "state",
          "providerId",
          "modelId",
          "usage",
          "cost",
          "providerLatencyMs",
          "appElapsedMs",
          "providerRequestId",
          "startedAt",
          "finishedAt"
        ]
      }
    },
    "events": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "id": {
            "type": "string",
            "pattern": "^evt_[0-7][0-9A-HJKMNP-TV-Z]{25}$"
          },
          "runId": {
            "type": "string",
            "pattern": "^run_[0-7][0-9A-HJKMNP-TV-Z]{25}$"
          },
          "seq": {
            "type": "integer",
            "minimum": 0,
            "maximum": 9007199254740991
          },
          "type": {
            "type": "string",
            "enum": [
              "run.created",
              "run.status_changed",
              "run.config_revised",
              "step.state_changed",
              "attempt.created",
              "attempt.dispatching",
              "attempt.stream_progress",
              "attempt.settled",
              "attempt.unknown",
              "ledger.reserved",
              "ledger.settled",
              "ledger.blocked",
              "approval.requested",
              "approval.decided",
              "artifact.created",
              "memory.suggested",
              "context.assembled",
              "error.recorded",
              "ledger.overrun",
              "artifact.write_failed",
              "run.limits_raised",
              "report.created",
              "run.snapshot_preserved"
            ]
          },
          "at": {
            "type": "integer",
            "minimum": 0,
            "maximum": 9007199254740991
          },
          "payload": {
            "type": "object",
            "propertyNames": {
              "type": "string"
            },
            "additionalProperties": {}
          }
        },
        "required": [
          "id",
          "runId",
          "seq",
          "type",
          "at",
          "payload"
        ]
      }
    }
  },
  "required": [
    "step",
    "output",
    "manifest",
    "attempts",
    "events"
  ]
}
```

## `runs.pause`

Channel `relay/v1/runs.pause` · command · route `runner`

### Input

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "runId": {
      "type": "string",
      "pattern": "^run_[0-7][0-9A-HJKMNP-TV-Z]{25}$"
    }
  },
  "required": [
    "runId"
  ]
}
```

### Output

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "status": {
      "type": "string",
      "enum": [
        "queued",
        "running",
        "awaiting_approval",
        "paused",
        "interrupted",
        "cancelling",
        "cancelled",
        "completed",
        "incomplete",
        "failed"
      ]
    },
    "inFlight": {
      "type": "string",
      "enum": [
        "none",
        "waiting",
        "unknown"
      ]
    }
  },
  "required": [
    "status",
    "inFlight"
  ]
}
```

## `runs.resume`

Channel `relay/v1/runs.resume` · command · route `runner`

### Input

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "idempotencyKey": {
      "type": "string",
      "minLength": 10,
      "maxLength": 64
    },
    "runId": {
      "type": "string",
      "pattern": "^run_[0-7][0-9A-HJKMNP-TV-Z]{25}$"
    },
    "decision": {
      "oneOf": [
        {
          "type": "object",
          "properties": {
            "kind": {
              "type": "string",
              "const": "continue"
            }
          },
          "required": [
            "kind"
          ]
        },
        {
          "type": "object",
          "properties": {
            "kind": {
              "type": "string",
              "const": "use_preserved_snapshot"
            }
          },
          "required": [
            "kind"
          ]
        },
        {
          "type": "object",
          "properties": {
            "kind": {
              "type": "string",
              "const": "resnapshot_and_replan"
            }
          },
          "required": [
            "kind"
          ]
        },
        {
          "type": "object",
          "properties": {
            "kind": {
              "type": "string",
              "const": "switch_profile"
            },
            "stepKey": {
              "type": "string",
              "pattern": "^[a-z][a-z0-9_-]{0,31}$"
            },
            "profileId": {
              "type": "string",
              "pattern": "^prf_[0-7][0-9A-HJKMNP-TV-Z]{25}$"
            }
          },
          "required": [
            "kind",
            "stepKey",
            "profileId"
          ]
        },
        {
          "type": "object",
          "properties": {
            "kind": {
              "type": "string",
              "const": "raise_limits"
            },
            "maxAttempts": {
              "type": "integer",
              "minimum": 1,
              "maximum": 50
            },
            "executionTimeoutSeconds": {
              "type": "integer",
              "minimum": 60,
              "maximum": 7200
            }
          },
          "required": [
            "kind"
          ]
        },
        {
          "type": "object",
          "properties": {
            "kind": {
              "type": "string",
              "const": "acknowledge_overrun"
            }
          },
          "required": [
            "kind"
          ]
        }
      ]
    }
  },
  "required": [
    "idempotencyKey",
    "runId",
    "decision"
  ]
}
```

### Output

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "status": {
      "type": "string",
      "enum": [
        "queued",
        "running",
        "awaiting_approval",
        "paused",
        "interrupted",
        "cancelling",
        "cancelled",
        "completed",
        "incomplete",
        "failed"
      ]
    }
  },
  "required": [
    "status"
  ]
}
```

## `runs.cancel`

Channel `relay/v1/runs.cancel` · command · route `runner`

### Input

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "runId": {
      "type": "string",
      "pattern": "^run_[0-7][0-9A-HJKMNP-TV-Z]{25}$"
    }
  },
  "required": [
    "runId"
  ]
}
```

### Output

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "status": {
      "type": "string",
      "enum": [
        "cancelling",
        "cancelled"
      ]
    },
    "unresolvedCharges": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "attemptId": {
            "type": "string",
            "pattern": "^att_[0-7][0-9A-HJKMNP-TV-Z]{25}$"
          },
          "liabilityMicrousd": {
            "type": "integer",
            "minimum": -9007199254740991,
            "maximum": 9007199254740991
          }
        },
        "required": [
          "attemptId",
          "liabilityMicrousd"
        ]
      }
    }
  },
  "required": [
    "status",
    "unresolvedCharges"
  ]
}
```

## `runs.increaseAllowance`

Channel `relay/v1/runs.increaseAllowance` · command · route `runner`

### Input

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "idempotencyKey": {
      "type": "string",
      "minLength": 10,
      "maxLength": 64
    },
    "runId": {
      "type": "string",
      "pattern": "^run_[0-7][0-9A-HJKMNP-TV-Z]{25}$"
    },
    "newAllowanceMicrousd": {
      "type": "integer",
      "minimum": 0,
      "maximum": 9007199254740991
    }
  },
  "required": [
    "idempotencyKey",
    "runId",
    "newAllowanceMicrousd"
  ]
}
```

### Output

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "cost": {
      "type": "object",
      "properties": {
        "allowance": {
          "type": "integer",
          "minimum": -9007199254740991,
          "maximum": 9007199254740991
        },
        "settledReported": {
          "type": "integer",
          "minimum": -9007199254740991,
          "maximum": 9007199254740991
        },
        "settledCalculated": {
          "type": "integer",
          "minimum": -9007199254740991,
          "maximum": 9007199254740991
        },
        "settledEstimated": {
          "type": "integer",
          "minimum": -9007199254740991,
          "maximum": 9007199254740991
        },
        "reserved": {
          "type": "integer",
          "minimum": -9007199254740991,
          "maximum": 9007199254740991
        },
        "unknown": {
          "type": "integer",
          "minimum": -9007199254740991,
          "maximum": 9007199254740991
        },
        "remaining": {
          "type": "integer",
          "minimum": -9007199254740991,
          "maximum": 9007199254740991
        },
        "overrun": {
          "type": "boolean"
        }
      },
      "required": [
        "allowance",
        "settledReported",
        "settledCalculated",
        "settledEstimated",
        "reserved",
        "unknown",
        "remaining",
        "overrun"
      ]
    },
    "status": {
      "type": "string",
      "enum": [
        "queued",
        "running",
        "awaiting_approval",
        "paused",
        "interrupted",
        "cancelling",
        "cancelled",
        "completed",
        "incomplete",
        "failed"
      ]
    },
    "budget": {
      "anyOf": [
        {
          "type": "object",
          "properties": {
            "L": {
              "type": "integer",
              "minimum": -9007199254740991,
              "maximum": 9007199254740991
            },
            "C": {
              "type": "integer",
              "minimum": -9007199254740991,
              "maximum": 9007199254740991
            },
            "R": {
              "type": "integer",
              "minimum": -9007199254740991,
              "maximum": 9007199254740991
            },
            "U": {
              "type": "integer",
              "minimum": -9007199254740991,
              "maximum": 9007199254740991
            },
            "N": {
              "type": "integer",
              "minimum": 0,
              "maximum": 9007199254740991
            },
            "scope": {
              "type": "string",
              "enum": [
                "run",
                "project",
                "setup"
              ]
            },
            "total": {
              "type": "integer",
              "minimum": -9007199254740991,
              "maximum": 9007199254740991
            },
            "allowed": {
              "type": "boolean"
            }
          },
          "required": [
            "L",
            "C",
            "R",
            "U",
            "N",
            "scope",
            "total",
            "allowed"
          ]
        },
        {
          "type": "null"
        }
      ]
    }
  },
  "required": [
    "cost",
    "status",
    "budget"
  ]
}
```

## `runs.decideUnknown`

Channel `relay/v1/runs.decideUnknown` · command · route `runner`

### Input

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "idempotencyKey": {
      "type": "string",
      "minLength": 10,
      "maxLength": 64
    },
    "runId": {
      "type": "string",
      "pattern": "^run_[0-7][0-9A-HJKMNP-TV-Z]{25}$"
    },
    "attemptId": {
      "type": "string",
      "pattern": "^att_[0-7][0-9A-HJKMNP-TV-Z]{25}$"
    },
    "decision": {
      "type": "string",
      "enum": [
        "retry_acknowledging_charge",
        "mark_failed_keep_liability",
        "accept_estimated_charge"
      ]
    }
  },
  "required": [
    "idempotencyKey",
    "runId",
    "attemptId",
    "decision"
  ]
}
```

### Output

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "id": {
      "type": "string",
      "pattern": "^run_[0-7][0-9A-HJKMNP-TV-Z]{25}$"
    },
    "projectId": {
      "type": "string",
      "pattern": "^prj_[0-7][0-9A-HJKMNP-TV-Z]{25}$"
    },
    "goal": {
      "type": "string"
    },
    "workflow": {
      "type": "object",
      "properties": {
        "id": {
          "type": "string",
          "pattern": "^wfl_[0-7][0-9A-HJKMNP-TV-Z]{25}$"
        },
        "version": {
          "type": "integer",
          "minimum": -9007199254740991,
          "maximum": 9007199254740991
        },
        "name": {
          "type": "string"
        }
      },
      "required": [
        "id",
        "version",
        "name"
      ]
    },
    "status": {
      "type": "string",
      "enum": [
        "queued",
        "running",
        "awaiting_approval",
        "paused",
        "interrupted",
        "cancelling",
        "cancelled",
        "completed",
        "incomplete",
        "failed"
      ]
    },
    "pauseReason": {
      "anyOf": [
        {
          "type": "string",
          "enum": [
            "budget_run",
            "budget_project",
            "user",
            "auth_required",
            "rate_limited",
            "setup_blocked",
            "approval_stale",
            "deadline",
            "limit_attempts",
            "unknown_outcome",
            "output_invalid",
            "provider_unavailable",
            "budget_overrun",
            "model_refused"
          ]
        },
        {
          "type": "null"
        }
      ]
    },
    "stepProgress": {
      "type": "object",
      "properties": {
        "done": {
          "type": "integer",
          "minimum": -9007199254740991,
          "maximum": 9007199254740991
        },
        "total": {
          "type": "integer",
          "minimum": -9007199254740991,
          "maximum": 9007199254740991
        }
      },
      "required": [
        "done",
        "total"
      ]
    },
    "cost": {
      "type": "object",
      "properties": {
        "allowance": {
          "type": "integer",
          "minimum": -9007199254740991,
          "maximum": 9007199254740991
        },
        "settledReported": {
          "type": "integer",
          "minimum": -9007199254740991,
          "maximum": 9007199254740991
        },
        "settledCalculated": {
          "type": "integer",
          "minimum": -9007199254740991,
          "maximum": 9007199254740991
        },
        "settledEstimated": {
          "type": "integer",
          "minimum": -9007199254740991,
          "maximum": 9007199254740991
        },
        "reserved": {
          "type": "integer",
          "minimum": -9007199254740991,
          "maximum": 9007199254740991
        },
        "unknown": {
          "type": "integer",
          "minimum": -9007199254740991,
          "maximum": 9007199254740991
        },
        "remaining": {
          "type": "integer",
          "minimum": -9007199254740991,
          "maximum": 9007199254740991
        },
        "overrun": {
          "type": "boolean"
        }
      },
      "required": [
        "allowance",
        "settledReported",
        "settledCalculated",
        "settledEstimated",
        "reserved",
        "unknown",
        "remaining",
        "overrun"
      ]
    },
    "createdAt": {
      "type": "integer",
      "minimum": 0,
      "maximum": 9007199254740991
    },
    "startedAt": {
      "anyOf": [
        {
          "type": "integer",
          "minimum": 0,
          "maximum": 9007199254740991
        },
        {
          "type": "null"
        }
      ]
    },
    "endedAt": {
      "anyOf": [
        {
          "type": "integer",
          "minimum": 0,
          "maximum": 9007199254740991
        },
        {
          "type": "null"
        }
      ]
    },
    "limits": {
      "type": "object",
      "properties": {
        "budgetMicrousd": {
          "type": "integer",
          "minimum": 0,
          "maximum": 9007199254740991
        },
        "maxRevisionCycles": {
          "type": "integer",
          "minimum": 0,
          "maximum": 5
        },
        "maxAttempts": {
          "type": "integer",
          "minimum": 1,
          "maximum": 50
        },
        "maxConcurrentSteps": {
          "type": "number",
          "const": 1
        },
        "executionTimeoutSeconds": {
          "type": "integer",
          "minimum": 60,
          "maximum": 7200
        },
        "maxToolCalls": {
          "type": "integer",
          "minimum": 0,
          "maximum": 0
        }
      },
      "required": [
        "budgetMicrousd",
        "maxRevisionCycles",
        "maxAttempts",
        "maxConcurrentSteps",
        "executionTimeoutSeconds",
        "maxToolCalls"
      ]
    },
    "input": {
      "oneOf": [
        {
          "type": "object",
          "properties": {
            "kind": {
              "type": "string",
              "const": "files"
            },
            "relPaths": {
              "minItems": 1,
              "maxItems": 200,
              "type": "array",
              "items": {
                "type": "string",
                "minLength": 1,
                "maxLength": 512
              }
            }
          },
          "required": [
            "kind",
            "relPaths"
          ]
        },
        {
          "type": "object",
          "properties": {
            "kind": {
              "type": "string",
              "const": "diff"
            },
            "diffArtifactId": {
              "type": "string",
              "pattern": "^art_[0-7][0-9A-HJKMNP-TV-Z]{25}$"
            }
          },
          "required": [
            "kind",
            "diffArtifactId"
          ]
        }
      ]
    },
    "contextHash": {
      "anyOf": [
        {
          "type": "string",
          "pattern": "^[a-f0-9]{64}$"
        },
        {
          "type": "null"
        }
      ]
    },
    "steps": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "id": {
            "type": "string",
            "pattern": "^stp_[0-7][0-9A-HJKMNP-TV-Z]{25}$"
          },
          "stepKey": {
            "type": "string",
            "pattern": "^[a-z][a-z0-9_-]{0,31}$"
          },
          "revisionIndex": {
            "type": "integer",
            "minimum": 0,
            "maximum": 9007199254740991
          },
          "retryIndex": {
            "type": "integer",
            "minimum": 0,
            "maximum": 9007199254740991
          },
          "state": {
            "type": "string",
            "enum": [
              "pending",
              "ready",
              "reserved",
              "executing",
              "validating",
              "awaiting_approval",
              "succeeded",
              "failed",
              "unknown",
              "skipped"
            ]
          },
          "profileName": {
            "type": [
              "string",
              "null"
            ]
          },
          "providerId": {
            "anyOf": [
              {
                "type": "string",
                "enum": [
                  "anthropic",
                  "openai",
                  "gemini",
                  "fake"
                ]
              },
              {
                "type": "null"
              }
            ]
          },
          "modelId": {
            "type": [
              "string",
              "null"
            ]
          },
          "outcome": {
            "type": [
              "string",
              "null"
            ]
          },
          "outputArtifactId": {
            "anyOf": [
              {
                "type": "string",
                "pattern": "^art_[0-7][0-9A-HJKMNP-TV-Z]{25}$"
              },
              {
                "type": "null"
              }
            ]
          },
          "error": {
            "anyOf": [
              {
                "type": "object",
                "properties": {
                  "code": {
                    "type": "string",
                    "enum": [
                      "AUTH_REQUIRED",
                      "MODEL_UNSUPPORTED",
                      "RATE_LIMITED",
                      "BUDGET_BLOCKED",
                      "CONTEXT_TOO_LARGE",
                      "OUTPUT_INVALID",
                      "APPROVAL_STALE",
                      "PROJECT_CHANGED",
                      "REQUEST_OUTCOME_UNKNOWN",
                      "ARTIFACT_WRITE_FAILED",
                      "RUNNER_UNAVAILABLE",
                      "PROVIDER_UNAVAILABLE",
                      "VALIDATION_FAILED",
                      "NOT_FOUND",
                      "CONFLICT",
                      "LIMIT_REACHED",
                      "PERMISSION_DENIED",
                      "SECURE_STORAGE_UNAVAILABLE",
                      "MODEL_REFUSED",
                      "INTERNAL"
                    ]
                  },
                  "userMessage": {
                    "type": "string",
                    "maxLength": 400
                  },
                  "retryable": {
                    "type": "boolean"
                  },
                  "nextAction": {
                    "type": "string",
                    "enum": [
                      "reconnect_provider",
                      "choose_profile",
                      "wait",
                      "increase_allowance",
                      "stop",
                      "narrow_scope",
                      "retry_step",
                      "reapprove",
                      "resnapshot_and_replan",
                      "use_preserved_snapshot",
                      "decide_unknown",
                      "retry_export",
                      "restart_runner",
                      "fix_input",
                      "none",
                      "reload",
                      "raise_limits",
                      "edit_policy",
                      "use_session_key",
                      "edit_goal",
                      "report_bug"
                    ]
                  },
                  "alternatives": {
                    "default": [],
                    "type": "array",
                    "items": {
                      "type": "string",
                      "enum": [
                        "reconnect_provider",
                        "choose_profile",
                        "wait",
                        "increase_allowance",
                        "stop",
                        "narrow_scope",
                        "retry_step",
                        "reapprove",
                        "resnapshot_and_replan",
                        "use_preserved_snapshot",
                        "decide_unknown",
                        "retry_export",
                        "restart_runner",
                        "fix_input",
                        "none",
                        "reload",
                        "raise_limits",
                        "edit_policy",
                        "use_session_key",
                        "edit_goal",
                        "report_bug"
                      ]
                    }
                  },
                  "attemptId": {
                    "type": "string",
                    "pattern": "^att_[0-7][0-9A-HJKMNP-TV-Z]{25}$"
                  },
                  "runId": {
                    "type": "string",
                    "pattern": "^run_[0-7][0-9A-HJKMNP-TV-Z]{25}$"
                  },
                  "details": {
                    "type": "object",
                    "propertyNames": {
                      "type": "string"
                    },
                    "additionalProperties": {}
                  },
                  "correlationId": {
                    "type": "string",
                    "pattern": "^cor_[0-7][0-9A-HJKMNP-TV-Z]{25}$"
                  }
                },
                "required": [
                  "code",
                  "userMessage",
                  "retryable",
                  "nextAction"
                ]
              },
              {
                "type": "null"
              }
            ]
          }
        },
        "required": [
          "id",
          "stepKey",
          "revisionIndex",
          "retryIndex",
          "state",
          "profileName",
          "providerId",
          "modelId",
          "outcome",
          "outputArtifactId",
          "error"
        ]
      }
    },
    "pendingApproval": {
      "anyOf": [
        {
          "type": "object",
          "properties": {
            "id": {
              "type": "string",
              "pattern": "^apr_[0-7][0-9A-HJKMNP-TV-Z]{25}$"
            },
            "planHash": {
              "type": "string",
              "pattern": "^[a-f0-9]{64}$"
            },
            "contextHash": {
              "type": "string",
              "pattern": "^[a-f0-9]{64}$"
            },
            "fileScope": {
              "type": "array",
              "items": {
                "type": "string",
                "minLength": 1,
                "maxLength": 512
              }
            },
            "providers": {
              "type": "array",
              "items": {
                "type": "string",
                "enum": [
                  "anthropic",
                  "openai",
                  "gemini",
                  "fake"
                ]
              }
            },
            "planArtifactId": {
              "type": "string",
              "pattern": "^art_[0-7][0-9A-HJKMNP-TV-Z]{25}$"
            },
            "decision": {
              "anyOf": [
                {
                  "type": "string",
                  "enum": [
                    "approved",
                    "revision_requested",
                    "rejected"
                  ]
                },
                {
                  "type": "null"
                }
              ]
            },
            "createdAt": {
              "type": "integer",
              "minimum": 0,
              "maximum": 9007199254740991
            }
          },
          "required": [
            "id",
            "planHash",
            "contextHash",
            "fileScope",
            "providers",
            "planArtifactId",
            "decision",
            "createdAt"
          ]
        },
        {
          "type": "null"
        }
      ]
    },
    "unresolvedAttempts": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "id": {
            "type": "string",
            "pattern": "^att_[0-7][0-9A-HJKMNP-TV-Z]{25}$"
          },
          "stepRunId": {
            "type": "string",
            "pattern": "^stp_[0-7][0-9A-HJKMNP-TV-Z]{25}$"
          },
          "stepKey": {
            "type": "string",
            "pattern": "^[a-z][a-z0-9_-]{0,31}$"
          },
          "seq": {
            "type": "integer",
            "exclusiveMinimum": 0,
            "maximum": 9007199254740991
          },
          "purpose": {
            "type": "string",
            "enum": [
              "initial",
              "transport_retry",
              "schema_repair",
              "user_retry",
              "reconcile"
            ]
          },
          "state": {
            "type": "string",
            "enum": [
              "created",
              "reserved",
              "dispatching",
              "succeeded",
              "failed_before_dispatch",
              "failed",
              "unknown",
              "reconciled_succeeded",
              "reconciled_failed",
              "abandoned"
            ]
          },
          "providerId": {
            "type": "string",
            "enum": [
              "anthropic",
              "openai",
              "gemini",
              "fake"
            ]
          },
          "modelId": {
            "type": "string"
          },
          "usage": {
            "anyOf": [
              {
                "type": "object",
                "properties": {
                  "uncachedInputTokens": {
                    "type": "integer",
                    "minimum": 0,
                    "maximum": 9007199254740991
                  },
                  "cacheReadInputTokens": {
                    "type": "integer",
                    "minimum": 0,
                    "maximum": 9007199254740991
                  },
                  "cacheWriteInputTokens": {
                    "type": "integer",
                    "minimum": 0,
                    "maximum": 9007199254740991
                  },
                  "outputTokens": {
                    "type": "integer",
                    "minimum": 0,
                    "maximum": 9007199254740991
                  },
                  "reasoningTokens": {
                    "type": "integer",
                    "minimum": 0,
                    "maximum": 9007199254740991
                  },
                  "partial": {
                    "type": "boolean"
                  }
                },
                "required": [
                  "uncachedInputTokens",
                  "cacheReadInputTokens",
                  "cacheWriteInputTokens",
                  "outputTokens"
                ]
              },
              {
                "type": "null"
              }
            ]
          },
          "cost": {
            "anyOf": [
              {
                "type": "object",
                "properties": {
                  "microusd": {
                    "type": "integer",
                    "minimum": -9007199254740991,
                    "maximum": 9007199254740991
                  },
                  "certainty": {
                    "type": "string",
                    "enum": [
                      "reported",
                      "calculated",
                      "estimated",
                      "unknown"
                    ]
                  }
                },
                "required": [
                  "microusd",
                  "certainty"
                ]
              },
              {
                "type": "null"
              }
            ]
          },
          "providerLatencyMs": {
            "anyOf": [
              {
                "type": "integer",
                "minimum": 0,
                "maximum": 9007199254740991
              },
              {
                "type": "null"
              }
            ]
          },
          "appElapsedMs": {
            "anyOf": [
              {
                "type": "integer",
                "minimum": 0,
                "maximum": 9007199254740991
              },
              {
                "type": "null"
              }
            ]
          },
          "providerRequestId": {
            "type": [
              "string",
              "null"
            ]
          },
          "startedAt": {
            "type": "integer",
            "minimum": 0,
            "maximum": 9007199254740991
          },
          "finishedAt": {
            "anyOf": [
              {
                "type": "integer",
                "minimum": 0,
                "maximum": 9007199254740991
              },
              {
                "type": "null"
              }
            ]
          }
        },
        "required": [
          "id",
          "stepRunId",
          "stepKey",
          "seq",
          "purpose",
          "state",
          "providerId",
          "modelId",
          "usage",
          "cost",
          "providerLatencyMs",
          "appElapsedMs",
          "providerRequestId",
          "startedAt",
          "finishedAt"
        ]
      }
    },
    "executionMsUsed": {
      "type": "integer",
      "minimum": 0,
      "maximum": 9007199254740991
    },
    "revisionCycle": {
      "type": "integer",
      "minimum": -9007199254740991,
      "maximum": 9007199254740991
    },
    "statusDetail": {
      "anyOf": [
        {
          "type": "object",
          "properties": {
            "code": {
              "type": "string",
              "enum": [
                "AUTH_REQUIRED",
                "MODEL_UNSUPPORTED",
                "RATE_LIMITED",
                "BUDGET_BLOCKED",
                "CONTEXT_TOO_LARGE",
                "OUTPUT_INVALID",
                "APPROVAL_STALE",
                "PROJECT_CHANGED",
                "REQUEST_OUTCOME_UNKNOWN",
                "ARTIFACT_WRITE_FAILED",
                "RUNNER_UNAVAILABLE",
                "PROVIDER_UNAVAILABLE",
                "VALIDATION_FAILED",
                "NOT_FOUND",
                "CONFLICT",
                "LIMIT_REACHED",
                "PERMISSION_DENIED",
                "SECURE_STORAGE_UNAVAILABLE",
                "MODEL_REFUSED",
                "INTERNAL"
              ]
            },
            "userMessage": {
              "type": "string",
              "maxLength": 400
            },
            "retryable": {
              "type": "boolean"
            },
            "nextAction": {
              "type": "string",
              "enum": [
                "reconnect_provider",
                "choose_profile",
                "wait",
                "increase_allowance",
                "stop",
                "narrow_scope",
                "retry_step",
                "reapprove",
                "resnapshot_and_replan",
                "use_preserved_snapshot",
                "decide_unknown",
                "retry_export",
                "restart_runner",
                "fix_input",
                "none",
                "reload",
                "raise_limits",
                "edit_policy",
                "use_session_key",
                "edit_goal",
                "report_bug"
              ]
            },
            "alternatives": {
              "default": [],
              "type": "array",
              "items": {
                "type": "string",
                "enum": [
                  "reconnect_provider",
                  "choose_profile",
                  "wait",
                  "increase_allowance",
                  "stop",
                  "narrow_scope",
                  "retry_step",
                  "reapprove",
                  "resnapshot_and_replan",
                  "use_preserved_snapshot",
                  "decide_unknown",
                  "retry_export",
                  "restart_runner",
                  "fix_input",
                  "none",
                  "reload",
                  "raise_limits",
                  "edit_policy",
                  "use_session_key",
                  "edit_goal",
                  "report_bug"
                ]
              }
            },
            "attemptId": {
              "type": "string",
              "pattern": "^att_[0-7][0-9A-HJKMNP-TV-Z]{25}$"
            },
            "runId": {
              "type": "string",
              "pattern": "^run_[0-7][0-9A-HJKMNP-TV-Z]{25}$"
            },
            "details": {
              "type": "object",
              "propertyNames": {
                "type": "string"
              },
              "additionalProperties": {}
            },
            "correlationId": {
              "type": "string",
              "pattern": "^cor_[0-7][0-9A-HJKMNP-TV-Z]{25}$"
            }
          },
          "required": [
            "code",
            "userMessage",
            "retryable",
            "nextAction"
          ]
        },
        {
          "type": "null"
        }
      ]
    },
    "reportArtifactId": {
      "anyOf": [
        {
          "type": "string",
          "pattern": "^art_[0-7][0-9A-HJKMNP-TV-Z]{25}$"
        },
        {
          "type": "null"
        }
      ]
    },
    "availableActions": {
      "type": "array",
      "items": {
        "type": "string",
        "enum": [
          "pause",
          "cancel",
          "stop",
          "resume",
          "approve",
          "request_revision",
          "reject",
          "increase_allowance",
          "edit_project_allowance",
          "choose_profile",
          "retry_step",
          "raise_limits",
          "acknowledge_overrun",
          "reconnect_provider",
          "resnapshot_and_replan",
          "use_preserved_snapshot",
          "decide_unknown",
          "review_recovery",
          "export_report",
          "export_patch"
        ]
      }
    }
  },
  "required": [
    "id",
    "projectId",
    "goal",
    "workflow",
    "status",
    "pauseReason",
    "stepProgress",
    "cost",
    "createdAt",
    "startedAt",
    "endedAt",
    "limits",
    "input",
    "contextHash",
    "steps",
    "pendingApproval",
    "unresolvedAttempts",
    "executionMsUsed",
    "revisionCycle",
    "statusDetail",
    "reportArtifactId",
    "availableActions"
  ]
}
```

## `runs.retryStep`

Channel `relay/v1/runs.retryStep` · command · route `runner`

### Input

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "idempotencyKey": {
      "type": "string",
      "minLength": 10,
      "maxLength": 64
    },
    "runId": {
      "type": "string",
      "pattern": "^run_[0-7][0-9A-HJKMNP-TV-Z]{25}$"
    },
    "stepId": {
      "type": "string",
      "pattern": "^stp_[0-7][0-9A-HJKMNP-TV-Z]{25}$"
    },
    "profileId": {
      "type": "string",
      "pattern": "^prf_[0-7][0-9A-HJKMNP-TV-Z]{25}$"
    }
  },
  "required": [
    "idempotencyKey",
    "runId",
    "stepId"
  ]
}
```

### Output

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "id": {
      "type": "string",
      "pattern": "^run_[0-7][0-9A-HJKMNP-TV-Z]{25}$"
    },
    "projectId": {
      "type": "string",
      "pattern": "^prj_[0-7][0-9A-HJKMNP-TV-Z]{25}$"
    },
    "goal": {
      "type": "string"
    },
    "workflow": {
      "type": "object",
      "properties": {
        "id": {
          "type": "string",
          "pattern": "^wfl_[0-7][0-9A-HJKMNP-TV-Z]{25}$"
        },
        "version": {
          "type": "integer",
          "minimum": -9007199254740991,
          "maximum": 9007199254740991
        },
        "name": {
          "type": "string"
        }
      },
      "required": [
        "id",
        "version",
        "name"
      ]
    },
    "status": {
      "type": "string",
      "enum": [
        "queued",
        "running",
        "awaiting_approval",
        "paused",
        "interrupted",
        "cancelling",
        "cancelled",
        "completed",
        "incomplete",
        "failed"
      ]
    },
    "pauseReason": {
      "anyOf": [
        {
          "type": "string",
          "enum": [
            "budget_run",
            "budget_project",
            "user",
            "auth_required",
            "rate_limited",
            "setup_blocked",
            "approval_stale",
            "deadline",
            "limit_attempts",
            "unknown_outcome",
            "output_invalid",
            "provider_unavailable",
            "budget_overrun",
            "model_refused"
          ]
        },
        {
          "type": "null"
        }
      ]
    },
    "stepProgress": {
      "type": "object",
      "properties": {
        "done": {
          "type": "integer",
          "minimum": -9007199254740991,
          "maximum": 9007199254740991
        },
        "total": {
          "type": "integer",
          "minimum": -9007199254740991,
          "maximum": 9007199254740991
        }
      },
      "required": [
        "done",
        "total"
      ]
    },
    "cost": {
      "type": "object",
      "properties": {
        "allowance": {
          "type": "integer",
          "minimum": -9007199254740991,
          "maximum": 9007199254740991
        },
        "settledReported": {
          "type": "integer",
          "minimum": -9007199254740991,
          "maximum": 9007199254740991
        },
        "settledCalculated": {
          "type": "integer",
          "minimum": -9007199254740991,
          "maximum": 9007199254740991
        },
        "settledEstimated": {
          "type": "integer",
          "minimum": -9007199254740991,
          "maximum": 9007199254740991
        },
        "reserved": {
          "type": "integer",
          "minimum": -9007199254740991,
          "maximum": 9007199254740991
        },
        "unknown": {
          "type": "integer",
          "minimum": -9007199254740991,
          "maximum": 9007199254740991
        },
        "remaining": {
          "type": "integer",
          "minimum": -9007199254740991,
          "maximum": 9007199254740991
        },
        "overrun": {
          "type": "boolean"
        }
      },
      "required": [
        "allowance",
        "settledReported",
        "settledCalculated",
        "settledEstimated",
        "reserved",
        "unknown",
        "remaining",
        "overrun"
      ]
    },
    "createdAt": {
      "type": "integer",
      "minimum": 0,
      "maximum": 9007199254740991
    },
    "startedAt": {
      "anyOf": [
        {
          "type": "integer",
          "minimum": 0,
          "maximum": 9007199254740991
        },
        {
          "type": "null"
        }
      ]
    },
    "endedAt": {
      "anyOf": [
        {
          "type": "integer",
          "minimum": 0,
          "maximum": 9007199254740991
        },
        {
          "type": "null"
        }
      ]
    },
    "limits": {
      "type": "object",
      "properties": {
        "budgetMicrousd": {
          "type": "integer",
          "minimum": 0,
          "maximum": 9007199254740991
        },
        "maxRevisionCycles": {
          "type": "integer",
          "minimum": 0,
          "maximum": 5
        },
        "maxAttempts": {
          "type": "integer",
          "minimum": 1,
          "maximum": 50
        },
        "maxConcurrentSteps": {
          "type": "number",
          "const": 1
        },
        "executionTimeoutSeconds": {
          "type": "integer",
          "minimum": 60,
          "maximum": 7200
        },
        "maxToolCalls": {
          "type": "integer",
          "minimum": 0,
          "maximum": 0
        }
      },
      "required": [
        "budgetMicrousd",
        "maxRevisionCycles",
        "maxAttempts",
        "maxConcurrentSteps",
        "executionTimeoutSeconds",
        "maxToolCalls"
      ]
    },
    "input": {
      "oneOf": [
        {
          "type": "object",
          "properties": {
            "kind": {
              "type": "string",
              "const": "files"
            },
            "relPaths": {
              "minItems": 1,
              "maxItems": 200,
              "type": "array",
              "items": {
                "type": "string",
                "minLength": 1,
                "maxLength": 512
              }
            }
          },
          "required": [
            "kind",
            "relPaths"
          ]
        },
        {
          "type": "object",
          "properties": {
            "kind": {
              "type": "string",
              "const": "diff"
            },
            "diffArtifactId": {
              "type": "string",
              "pattern": "^art_[0-7][0-9A-HJKMNP-TV-Z]{25}$"
            }
          },
          "required": [
            "kind",
            "diffArtifactId"
          ]
        }
      ]
    },
    "contextHash": {
      "anyOf": [
        {
          "type": "string",
          "pattern": "^[a-f0-9]{64}$"
        },
        {
          "type": "null"
        }
      ]
    },
    "steps": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "id": {
            "type": "string",
            "pattern": "^stp_[0-7][0-9A-HJKMNP-TV-Z]{25}$"
          },
          "stepKey": {
            "type": "string",
            "pattern": "^[a-z][a-z0-9_-]{0,31}$"
          },
          "revisionIndex": {
            "type": "integer",
            "minimum": 0,
            "maximum": 9007199254740991
          },
          "retryIndex": {
            "type": "integer",
            "minimum": 0,
            "maximum": 9007199254740991
          },
          "state": {
            "type": "string",
            "enum": [
              "pending",
              "ready",
              "reserved",
              "executing",
              "validating",
              "awaiting_approval",
              "succeeded",
              "failed",
              "unknown",
              "skipped"
            ]
          },
          "profileName": {
            "type": [
              "string",
              "null"
            ]
          },
          "providerId": {
            "anyOf": [
              {
                "type": "string",
                "enum": [
                  "anthropic",
                  "openai",
                  "gemini",
                  "fake"
                ]
              },
              {
                "type": "null"
              }
            ]
          },
          "modelId": {
            "type": [
              "string",
              "null"
            ]
          },
          "outcome": {
            "type": [
              "string",
              "null"
            ]
          },
          "outputArtifactId": {
            "anyOf": [
              {
                "type": "string",
                "pattern": "^art_[0-7][0-9A-HJKMNP-TV-Z]{25}$"
              },
              {
                "type": "null"
              }
            ]
          },
          "error": {
            "anyOf": [
              {
                "type": "object",
                "properties": {
                  "code": {
                    "type": "string",
                    "enum": [
                      "AUTH_REQUIRED",
                      "MODEL_UNSUPPORTED",
                      "RATE_LIMITED",
                      "BUDGET_BLOCKED",
                      "CONTEXT_TOO_LARGE",
                      "OUTPUT_INVALID",
                      "APPROVAL_STALE",
                      "PROJECT_CHANGED",
                      "REQUEST_OUTCOME_UNKNOWN",
                      "ARTIFACT_WRITE_FAILED",
                      "RUNNER_UNAVAILABLE",
                      "PROVIDER_UNAVAILABLE",
                      "VALIDATION_FAILED",
                      "NOT_FOUND",
                      "CONFLICT",
                      "LIMIT_REACHED",
                      "PERMISSION_DENIED",
                      "SECURE_STORAGE_UNAVAILABLE",
                      "MODEL_REFUSED",
                      "INTERNAL"
                    ]
                  },
                  "userMessage": {
                    "type": "string",
                    "maxLength": 400
                  },
                  "retryable": {
                    "type": "boolean"
                  },
                  "nextAction": {
                    "type": "string",
                    "enum": [
                      "reconnect_provider",
                      "choose_profile",
                      "wait",
                      "increase_allowance",
                      "stop",
                      "narrow_scope",
                      "retry_step",
                      "reapprove",
                      "resnapshot_and_replan",
                      "use_preserved_snapshot",
                      "decide_unknown",
                      "retry_export",
                      "restart_runner",
                      "fix_input",
                      "none",
                      "reload",
                      "raise_limits",
                      "edit_policy",
                      "use_session_key",
                      "edit_goal",
                      "report_bug"
                    ]
                  },
                  "alternatives": {
                    "default": [],
                    "type": "array",
                    "items": {
                      "type": "string",
                      "enum": [
                        "reconnect_provider",
                        "choose_profile",
                        "wait",
                        "increase_allowance",
                        "stop",
                        "narrow_scope",
                        "retry_step",
                        "reapprove",
                        "resnapshot_and_replan",
                        "use_preserved_snapshot",
                        "decide_unknown",
                        "retry_export",
                        "restart_runner",
                        "fix_input",
                        "none",
                        "reload",
                        "raise_limits",
                        "edit_policy",
                        "use_session_key",
                        "edit_goal",
                        "report_bug"
                      ]
                    }
                  },
                  "attemptId": {
                    "type": "string",
                    "pattern": "^att_[0-7][0-9A-HJKMNP-TV-Z]{25}$"
                  },
                  "runId": {
                    "type": "string",
                    "pattern": "^run_[0-7][0-9A-HJKMNP-TV-Z]{25}$"
                  },
                  "details": {
                    "type": "object",
                    "propertyNames": {
                      "type": "string"
                    },
                    "additionalProperties": {}
                  },
                  "correlationId": {
                    "type": "string",
                    "pattern": "^cor_[0-7][0-9A-HJKMNP-TV-Z]{25}$"
                  }
                },
                "required": [
                  "code",
                  "userMessage",
                  "retryable",
                  "nextAction"
                ]
              },
              {
                "type": "null"
              }
            ]
          }
        },
        "required": [
          "id",
          "stepKey",
          "revisionIndex",
          "retryIndex",
          "state",
          "profileName",
          "providerId",
          "modelId",
          "outcome",
          "outputArtifactId",
          "error"
        ]
      }
    },
    "pendingApproval": {
      "anyOf": [
        {
          "type": "object",
          "properties": {
            "id": {
              "type": "string",
              "pattern": "^apr_[0-7][0-9A-HJKMNP-TV-Z]{25}$"
            },
            "planHash": {
              "type": "string",
              "pattern": "^[a-f0-9]{64}$"
            },
            "contextHash": {
              "type": "string",
              "pattern": "^[a-f0-9]{64}$"
            },
            "fileScope": {
              "type": "array",
              "items": {
                "type": "string",
                "minLength": 1,
                "maxLength": 512
              }
            },
            "providers": {
              "type": "array",
              "items": {
                "type": "string",
                "enum": [
                  "anthropic",
                  "openai",
                  "gemini",
                  "fake"
                ]
              }
            },
            "planArtifactId": {
              "type": "string",
              "pattern": "^art_[0-7][0-9A-HJKMNP-TV-Z]{25}$"
            },
            "decision": {
              "anyOf": [
                {
                  "type": "string",
                  "enum": [
                    "approved",
                    "revision_requested",
                    "rejected"
                  ]
                },
                {
                  "type": "null"
                }
              ]
            },
            "createdAt": {
              "type": "integer",
              "minimum": 0,
              "maximum": 9007199254740991
            }
          },
          "required": [
            "id",
            "planHash",
            "contextHash",
            "fileScope",
            "providers",
            "planArtifactId",
            "decision",
            "createdAt"
          ]
        },
        {
          "type": "null"
        }
      ]
    },
    "unresolvedAttempts": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "id": {
            "type": "string",
            "pattern": "^att_[0-7][0-9A-HJKMNP-TV-Z]{25}$"
          },
          "stepRunId": {
            "type": "string",
            "pattern": "^stp_[0-7][0-9A-HJKMNP-TV-Z]{25}$"
          },
          "stepKey": {
            "type": "string",
            "pattern": "^[a-z][a-z0-9_-]{0,31}$"
          },
          "seq": {
            "type": "integer",
            "exclusiveMinimum": 0,
            "maximum": 9007199254740991
          },
          "purpose": {
            "type": "string",
            "enum": [
              "initial",
              "transport_retry",
              "schema_repair",
              "user_retry",
              "reconcile"
            ]
          },
          "state": {
            "type": "string",
            "enum": [
              "created",
              "reserved",
              "dispatching",
              "succeeded",
              "failed_before_dispatch",
              "failed",
              "unknown",
              "reconciled_succeeded",
              "reconciled_failed",
              "abandoned"
            ]
          },
          "providerId": {
            "type": "string",
            "enum": [
              "anthropic",
              "openai",
              "gemini",
              "fake"
            ]
          },
          "modelId": {
            "type": "string"
          },
          "usage": {
            "anyOf": [
              {
                "type": "object",
                "properties": {
                  "uncachedInputTokens": {
                    "type": "integer",
                    "minimum": 0,
                    "maximum": 9007199254740991
                  },
                  "cacheReadInputTokens": {
                    "type": "integer",
                    "minimum": 0,
                    "maximum": 9007199254740991
                  },
                  "cacheWriteInputTokens": {
                    "type": "integer",
                    "minimum": 0,
                    "maximum": 9007199254740991
                  },
                  "outputTokens": {
                    "type": "integer",
                    "minimum": 0,
                    "maximum": 9007199254740991
                  },
                  "reasoningTokens": {
                    "type": "integer",
                    "minimum": 0,
                    "maximum": 9007199254740991
                  },
                  "partial": {
                    "type": "boolean"
                  }
                },
                "required": [
                  "uncachedInputTokens",
                  "cacheReadInputTokens",
                  "cacheWriteInputTokens",
                  "outputTokens"
                ]
              },
              {
                "type": "null"
              }
            ]
          },
          "cost": {
            "anyOf": [
              {
                "type": "object",
                "properties": {
                  "microusd": {
                    "type": "integer",
                    "minimum": -9007199254740991,
                    "maximum": 9007199254740991
                  },
                  "certainty": {
                    "type": "string",
                    "enum": [
                      "reported",
                      "calculated",
                      "estimated",
                      "unknown"
                    ]
                  }
                },
                "required": [
                  "microusd",
                  "certainty"
                ]
              },
              {
                "type": "null"
              }
            ]
          },
          "providerLatencyMs": {
            "anyOf": [
              {
                "type": "integer",
                "minimum": 0,
                "maximum": 9007199254740991
              },
              {
                "type": "null"
              }
            ]
          },
          "appElapsedMs": {
            "anyOf": [
              {
                "type": "integer",
                "minimum": 0,
                "maximum": 9007199254740991
              },
              {
                "type": "null"
              }
            ]
          },
          "providerRequestId": {
            "type": [
              "string",
              "null"
            ]
          },
          "startedAt": {
            "type": "integer",
            "minimum": 0,
            "maximum": 9007199254740991
          },
          "finishedAt": {
            "anyOf": [
              {
                "type": "integer",
                "minimum": 0,
                "maximum": 9007199254740991
              },
              {
                "type": "null"
              }
            ]
          }
        },
        "required": [
          "id",
          "stepRunId",
          "stepKey",
          "seq",
          "purpose",
          "state",
          "providerId",
          "modelId",
          "usage",
          "cost",
          "providerLatencyMs",
          "appElapsedMs",
          "providerRequestId",
          "startedAt",
          "finishedAt"
        ]
      }
    },
    "executionMsUsed": {
      "type": "integer",
      "minimum": 0,
      "maximum": 9007199254740991
    },
    "revisionCycle": {
      "type": "integer",
      "minimum": -9007199254740991,
      "maximum": 9007199254740991
    },
    "statusDetail": {
      "anyOf": [
        {
          "type": "object",
          "properties": {
            "code": {
              "type": "string",
              "enum": [
                "AUTH_REQUIRED",
                "MODEL_UNSUPPORTED",
                "RATE_LIMITED",
                "BUDGET_BLOCKED",
                "CONTEXT_TOO_LARGE",
                "OUTPUT_INVALID",
                "APPROVAL_STALE",
                "PROJECT_CHANGED",
                "REQUEST_OUTCOME_UNKNOWN",
                "ARTIFACT_WRITE_FAILED",
                "RUNNER_UNAVAILABLE",
                "PROVIDER_UNAVAILABLE",
                "VALIDATION_FAILED",
                "NOT_FOUND",
                "CONFLICT",
                "LIMIT_REACHED",
                "PERMISSION_DENIED",
                "SECURE_STORAGE_UNAVAILABLE",
                "MODEL_REFUSED",
                "INTERNAL"
              ]
            },
            "userMessage": {
              "type": "string",
              "maxLength": 400
            },
            "retryable": {
              "type": "boolean"
            },
            "nextAction": {
              "type": "string",
              "enum": [
                "reconnect_provider",
                "choose_profile",
                "wait",
                "increase_allowance",
                "stop",
                "narrow_scope",
                "retry_step",
                "reapprove",
                "resnapshot_and_replan",
                "use_preserved_snapshot",
                "decide_unknown",
                "retry_export",
                "restart_runner",
                "fix_input",
                "none",
                "reload",
                "raise_limits",
                "edit_policy",
                "use_session_key",
                "edit_goal",
                "report_bug"
              ]
            },
            "alternatives": {
              "default": [],
              "type": "array",
              "items": {
                "type": "string",
                "enum": [
                  "reconnect_provider",
                  "choose_profile",
                  "wait",
                  "increase_allowance",
                  "stop",
                  "narrow_scope",
                  "retry_step",
                  "reapprove",
                  "resnapshot_and_replan",
                  "use_preserved_snapshot",
                  "decide_unknown",
                  "retry_export",
                  "restart_runner",
                  "fix_input",
                  "none",
                  "reload",
                  "raise_limits",
                  "edit_policy",
                  "use_session_key",
                  "edit_goal",
                  "report_bug"
                ]
              }
            },
            "attemptId": {
              "type": "string",
              "pattern": "^att_[0-7][0-9A-HJKMNP-TV-Z]{25}$"
            },
            "runId": {
              "type": "string",
              "pattern": "^run_[0-7][0-9A-HJKMNP-TV-Z]{25}$"
            },
            "details": {
              "type": "object",
              "propertyNames": {
                "type": "string"
              },
              "additionalProperties": {}
            },
            "correlationId": {
              "type": "string",
              "pattern": "^cor_[0-7][0-9A-HJKMNP-TV-Z]{25}$"
            }
          },
          "required": [
            "code",
            "userMessage",
            "retryable",
            "nextAction"
          ]
        },
        {
          "type": "null"
        }
      ]
    },
    "reportArtifactId": {
      "anyOf": [
        {
          "type": "string",
          "pattern": "^art_[0-7][0-9A-HJKMNP-TV-Z]{25}$"
        },
        {
          "type": "null"
        }
      ]
    },
    "availableActions": {
      "type": "array",
      "items": {
        "type": "string",
        "enum": [
          "pause",
          "cancel",
          "stop",
          "resume",
          "approve",
          "request_revision",
          "reject",
          "increase_allowance",
          "edit_project_allowance",
          "choose_profile",
          "retry_step",
          "raise_limits",
          "acknowledge_overrun",
          "reconnect_provider",
          "resnapshot_and_replan",
          "use_preserved_snapshot",
          "decide_unknown",
          "review_recovery",
          "export_report",
          "export_patch"
        ]
      }
    }
  },
  "required": [
    "id",
    "projectId",
    "goal",
    "workflow",
    "status",
    "pauseReason",
    "stepProgress",
    "cost",
    "createdAt",
    "startedAt",
    "endedAt",
    "limits",
    "input",
    "contextHash",
    "steps",
    "pendingApproval",
    "unresolvedAttempts",
    "executionMsUsed",
    "revisionCycle",
    "statusDetail",
    "reportArtifactId",
    "availableActions"
  ]
}
```

## `runs.events`

Channel `relay/v1/runs.events` · query · route `runner`

### Input

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "runId": {
      "type": "string",
      "pattern": "^run_[0-7][0-9A-HJKMNP-TV-Z]{25}$"
    },
    "afterSeq": {
      "type": "integer",
      "minimum": 0,
      "maximum": 9007199254740991
    },
    "limit": {
      "default": 200,
      "type": "integer",
      "minimum": 1,
      "maximum": 500
    }
  },
  "required": [
    "runId",
    "afterSeq"
  ]
}
```

### Output

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "items": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "id": {
            "type": "string",
            "pattern": "^evt_[0-7][0-9A-HJKMNP-TV-Z]{25}$"
          },
          "runId": {
            "type": "string",
            "pattern": "^run_[0-7][0-9A-HJKMNP-TV-Z]{25}$"
          },
          "seq": {
            "type": "integer",
            "minimum": 0,
            "maximum": 9007199254740991
          },
          "type": {
            "type": "string",
            "enum": [
              "run.created",
              "run.status_changed",
              "run.config_revised",
              "step.state_changed",
              "attempt.created",
              "attempt.dispatching",
              "attempt.stream_progress",
              "attempt.settled",
              "attempt.unknown",
              "ledger.reserved",
              "ledger.settled",
              "ledger.blocked",
              "approval.requested",
              "approval.decided",
              "artifact.created",
              "memory.suggested",
              "context.assembled",
              "error.recorded",
              "ledger.overrun",
              "artifact.write_failed",
              "run.limits_raised",
              "report.created",
              "run.snapshot_preserved"
            ]
          },
          "at": {
            "type": "integer",
            "minimum": 0,
            "maximum": 9007199254740991
          },
          "payload": {
            "type": "object",
            "propertyNames": {
              "type": "string"
            },
            "additionalProperties": {}
          }
        },
        "required": [
          "id",
          "runId",
          "seq",
          "type",
          "at",
          "payload"
        ]
      }
    },
    "nextCursor": {
      "type": [
        "string",
        "null"
      ]
    }
  },
  "required": [
    "items",
    "nextCursor"
  ]
}
```

## `approvals.decide`

Channel `relay/v1/approvals.decide` · command · route `runner`

### Input

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "idempotencyKey": {
      "type": "string",
      "minLength": 10,
      "maxLength": 64
    },
    "approvalId": {
      "type": "string",
      "pattern": "^apr_[0-7][0-9A-HJKMNP-TV-Z]{25}$"
    },
    "planHash": {
      "type": "string",
      "pattern": "^[a-f0-9]{64}$"
    },
    "contextHash": {
      "type": "string",
      "pattern": "^[a-f0-9]{64}$"
    },
    "decision": {
      "type": "string",
      "enum": [
        "approved",
        "revision_requested",
        "rejected"
      ]
    },
    "note": {
      "type": "string",
      "maxLength": 2000
    }
  },
  "required": [
    "idempotencyKey",
    "approvalId",
    "planHash",
    "contextHash",
    "decision"
  ]
}
```

### Output

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "approval": {
      "type": "object",
      "properties": {
        "id": {
          "type": "string",
          "pattern": "^apr_[0-7][0-9A-HJKMNP-TV-Z]{25}$"
        },
        "planHash": {
          "type": "string",
          "pattern": "^[a-f0-9]{64}$"
        },
        "contextHash": {
          "type": "string",
          "pattern": "^[a-f0-9]{64}$"
        },
        "fileScope": {
          "type": "array",
          "items": {
            "type": "string",
            "minLength": 1,
            "maxLength": 512
          }
        },
        "providers": {
          "type": "array",
          "items": {
            "type": "string",
            "enum": [
              "anthropic",
              "openai",
              "gemini",
              "fake"
            ]
          }
        },
        "planArtifactId": {
          "type": "string",
          "pattern": "^art_[0-7][0-9A-HJKMNP-TV-Z]{25}$"
        },
        "decision": {
          "anyOf": [
            {
              "type": "string",
              "enum": [
                "approved",
                "revision_requested",
                "rejected"
              ]
            },
            {
              "type": "null"
            }
          ]
        },
        "createdAt": {
          "type": "integer",
          "minimum": 0,
          "maximum": 9007199254740991
        }
      },
      "required": [
        "id",
        "planHash",
        "contextHash",
        "fileScope",
        "providers",
        "planArtifactId",
        "decision",
        "createdAt"
      ]
    },
    "runStatus": {
      "type": "string",
      "enum": [
        "queued",
        "running",
        "awaiting_approval",
        "paused",
        "interrupted",
        "cancelling",
        "cancelled",
        "completed",
        "incomplete",
        "failed"
      ]
    }
  },
  "required": [
    "approval",
    "runStatus"
  ]
}
```

## `memory.list`

Channel `relay/v1/memory.list` · query · route `runner`

### Input

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "projectId": {
      "type": "string",
      "pattern": "^prj_[0-7][0-9A-HJKMNP-TV-Z]{25}$"
    },
    "status": {
      "type": "array",
      "items": {
        "type": "string",
        "enum": [
          "suggested",
          "approved",
          "archived",
          "rejected",
          "deleted"
        ]
      }
    },
    "type": {
      "type": "array",
      "items": {
        "type": "string",
        "enum": [
          "user_rule",
          "project_decision",
          "source_reference",
          "run_summary"
        ]
      }
    },
    "query": {
      "type": "string",
      "maxLength": 200
    }
  },
  "required": [
    "projectId"
  ]
}
```

### Output

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "array",
  "items": {
    "type": "object",
    "properties": {
      "id": {
        "type": "string",
        "pattern": "^mem_[0-7][0-9A-HJKMNP-TV-Z]{25}$"
      },
      "projectId": {
        "type": "string",
        "pattern": "^prj_[0-7][0-9A-HJKMNP-TV-Z]{25}$"
      },
      "type": {
        "type": "string",
        "enum": [
          "user_rule",
          "project_decision",
          "source_reference",
          "run_summary"
        ]
      },
      "status": {
        "type": "string",
        "enum": [
          "suggested",
          "approved",
          "archived",
          "rejected",
          "deleted"
        ]
      },
      "title": {
        "type": "string"
      },
      "excerpt": {
        "type": "string"
      },
      "scope": {
        "type": "object",
        "properties": {
          "roles": {
            "anyOf": [
              {
                "minItems": 1,
                "type": "array",
                "items": {
                  "type": "string",
                  "enum": [
                    "reviewer",
                    "planner",
                    "implementer",
                    "verifier"
                  ]
                }
              },
              {
                "type": "string",
                "const": "all"
              }
            ]
          }
        },
        "required": [
          "roles"
        ]
      },
      "pinned": {
        "type": "boolean"
      },
      "currentRevision": {
        "type": "integer",
        "exclusiveMinimum": 0,
        "maximum": 9007199254740991
      },
      "source": {
        "oneOf": [
          {
            "type": "object",
            "properties": {
              "kind": {
                "type": "string",
                "const": "user"
              }
            },
            "required": [
              "kind"
            ]
          },
          {
            "type": "object",
            "properties": {
              "kind": {
                "type": "string",
                "const": "run"
              },
              "runId": {
                "type": "string",
                "pattern": "^run_[0-7][0-9A-HJKMNP-TV-Z]{25}$"
              },
              "artifactId": {
                "type": "string",
                "pattern": "^art_[0-7][0-9A-HJKMNP-TV-Z]{25}$"
              }
            },
            "required": [
              "kind",
              "runId"
            ]
          },
          {
            "type": "object",
            "properties": {
              "kind": {
                "type": "string",
                "const": "file"
              },
              "relPath": {
                "type": "string",
                "minLength": 1,
                "maxLength": 512
              }
            },
            "required": [
              "kind",
              "relPath"
            ]
          }
        ]
      },
      "createdAt": {
        "type": "integer",
        "minimum": 0,
        "maximum": 9007199254740991
      },
      "updatedAt": {
        "type": "integer",
        "minimum": 0,
        "maximum": 9007199254740991
      },
      "expiresAt": {
        "anyOf": [
          {
            "type": "integer",
            "minimum": 0,
            "maximum": 9007199254740991
          },
          {
            "type": "null"
          }
        ]
      },
      "reviewAt": {
        "anyOf": [
          {
            "type": "integer",
            "minimum": 0,
            "maximum": 9007199254740991
          },
          {
            "type": "null"
          }
        ]
      },
      "supersededById": {
        "anyOf": [
          {
            "type": "string",
            "pattern": "^mem_[0-7][0-9A-HJKMNP-TV-Z]{25}$"
          },
          {
            "type": "null"
          }
        ]
      },
      "stale": {
        "type": "boolean"
      },
      "conflictsWith": {
        "type": "array",
        "items": {
          "type": "string",
          "pattern": "^mem_[0-7][0-9A-HJKMNP-TV-Z]{25}$"
        }
      }
    },
    "required": [
      "id",
      "projectId",
      "type",
      "status",
      "title",
      "excerpt",
      "scope",
      "pinned",
      "currentRevision",
      "source",
      "createdAt",
      "updatedAt",
      "expiresAt",
      "reviewAt",
      "supersededById",
      "stale",
      "conflictsWith"
    ]
  }
}
```

## `memory.get`

Channel `relay/v1/memory.get` · query · route `runner`

### Input

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "recordId": {
      "type": "string",
      "pattern": "^mem_[0-7][0-9A-HJKMNP-TV-Z]{25}$"
    }
  },
  "required": [
    "recordId"
  ]
}
```

### Output

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "id": {
      "type": "string",
      "pattern": "^mem_[0-7][0-9A-HJKMNP-TV-Z]{25}$"
    },
    "projectId": {
      "type": "string",
      "pattern": "^prj_[0-7][0-9A-HJKMNP-TV-Z]{25}$"
    },
    "type": {
      "type": "string",
      "enum": [
        "user_rule",
        "project_decision",
        "source_reference",
        "run_summary"
      ]
    },
    "status": {
      "type": "string",
      "enum": [
        "suggested",
        "approved",
        "archived",
        "rejected",
        "deleted"
      ]
    },
    "title": {
      "type": "string"
    },
    "excerpt": {
      "type": "string"
    },
    "scope": {
      "type": "object",
      "properties": {
        "roles": {
          "anyOf": [
            {
              "minItems": 1,
              "type": "array",
              "items": {
                "type": "string",
                "enum": [
                  "reviewer",
                  "planner",
                  "implementer",
                  "verifier"
                ]
              }
            },
            {
              "type": "string",
              "const": "all"
            }
          ]
        }
      },
      "required": [
        "roles"
      ]
    },
    "pinned": {
      "type": "boolean"
    },
    "currentRevision": {
      "type": "integer",
      "exclusiveMinimum": 0,
      "maximum": 9007199254740991
    },
    "source": {
      "oneOf": [
        {
          "type": "object",
          "properties": {
            "kind": {
              "type": "string",
              "const": "user"
            }
          },
          "required": [
            "kind"
          ]
        },
        {
          "type": "object",
          "properties": {
            "kind": {
              "type": "string",
              "const": "run"
            },
            "runId": {
              "type": "string",
              "pattern": "^run_[0-7][0-9A-HJKMNP-TV-Z]{25}$"
            },
            "artifactId": {
              "type": "string",
              "pattern": "^art_[0-7][0-9A-HJKMNP-TV-Z]{25}$"
            }
          },
          "required": [
            "kind",
            "runId"
          ]
        },
        {
          "type": "object",
          "properties": {
            "kind": {
              "type": "string",
              "const": "file"
            },
            "relPath": {
              "type": "string",
              "minLength": 1,
              "maxLength": 512
            }
          },
          "required": [
            "kind",
            "relPath"
          ]
        }
      ]
    },
    "createdAt": {
      "type": "integer",
      "minimum": 0,
      "maximum": 9007199254740991
    },
    "updatedAt": {
      "type": "integer",
      "minimum": 0,
      "maximum": 9007199254740991
    },
    "expiresAt": {
      "anyOf": [
        {
          "type": "integer",
          "minimum": 0,
          "maximum": 9007199254740991
        },
        {
          "type": "null"
        }
      ]
    },
    "reviewAt": {
      "anyOf": [
        {
          "type": "integer",
          "minimum": 0,
          "maximum": 9007199254740991
        },
        {
          "type": "null"
        }
      ]
    },
    "supersededById": {
      "anyOf": [
        {
          "type": "string",
          "pattern": "^mem_[0-7][0-9A-HJKMNP-TV-Z]{25}$"
        },
        {
          "type": "null"
        }
      ]
    },
    "stale": {
      "type": "boolean"
    },
    "conflictsWith": {
      "type": "array",
      "items": {
        "type": "string",
        "pattern": "^mem_[0-7][0-9A-HJKMNP-TV-Z]{25}$"
      }
    },
    "content": {
      "type": "string"
    },
    "revisions": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "revision": {
            "type": "integer",
            "exclusiveMinimum": 0,
            "maximum": 9007199254740991
          },
          "title": {
            "type": "string"
          },
          "content": {
            "type": "string"
          },
          "author": {
            "type": "string",
            "pattern": "^(user|run:run_[0-7][0-9A-HJKMNP-TV-Z]{25})$"
          },
          "createdAt": {
            "type": "integer",
            "minimum": 0,
            "maximum": 9007199254740991
          },
          "sourceRefs": {
            "type": "array",
            "items": {
              "oneOf": [
                {
                  "type": "object",
                  "properties": {
                    "kind": {
                      "type": "string",
                      "const": "file"
                    },
                    "relPath": {
                      "type": "string",
                      "minLength": 1,
                      "maxLength": 512
                    },
                    "sha256": {
                      "type": "string",
                      "pattern": "^[a-f0-9]{64}$"
                    }
                  },
                  "required": [
                    "kind",
                    "relPath",
                    "sha256"
                  ]
                },
                {
                  "type": "object",
                  "properties": {
                    "kind": {
                      "type": "string",
                      "const": "run"
                    },
                    "runId": {
                      "type": "string",
                      "pattern": "^run_[0-7][0-9A-HJKMNP-TV-Z]{25}$"
                    },
                    "artifactId": {
                      "anyOf": [
                        {
                          "type": "string",
                          "pattern": "^art_[0-7][0-9A-HJKMNP-TV-Z]{25}$"
                        },
                        {
                          "type": "null"
                        }
                      ]
                    }
                  },
                  "required": [
                    "kind",
                    "runId",
                    "artifactId"
                  ]
                }
              ]
            }
          }
        },
        "required": [
          "revision",
          "title",
          "content",
          "author",
          "createdAt",
          "sourceRefs"
        ]
      }
    },
    "events": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "event": {
            "type": "string",
            "enum": [
              "suggested",
              "approved",
              "edited",
              "archived",
              "rejected",
              "deleted",
              "conflict_resolved",
              "unarchived",
              "history_purged"
            ]
          },
          "revision": {
            "type": "integer",
            "exclusiveMinimum": 0,
            "maximum": 9007199254740991
          },
          "actor": {
            "type": "string",
            "pattern": "^(user|run:run_[0-7][0-9A-HJKMNP-TV-Z]{25})$"
          },
          "createdAt": {
            "type": "integer",
            "minimum": 0,
            "maximum": 9007199254740991
          }
        },
        "required": [
          "event",
          "revision",
          "actor",
          "createdAt"
        ]
      }
    },
    "usedByRuns": {
      "type": "integer",
      "minimum": 0,
      "maximum": 9007199254740991
    },
    "proposal": {
      "type": "object",
      "properties": {
        "rationale": {
          "type": "string"
        },
        "suggestedScope": {
          "type": "object",
          "properties": {
            "roles": {
              "anyOf": [
                {
                  "minItems": 1,
                  "type": "array",
                  "items": {
                    "type": "string",
                    "enum": [
                      "reviewer",
                      "planner",
                      "implementer",
                      "verifier"
                    ]
                  }
                },
                {
                  "type": "string",
                  "const": "all"
                }
              ]
            }
          },
          "required": [
            "roles"
          ]
        },
        "conflictsWith": {
          "type": "array",
          "items": {
            "type": "string",
            "pattern": "^mem_[0-7][0-9A-HJKMNP-TV-Z]{25}$"
          }
        }
      },
      "required": [
        "rationale",
        "suggestedScope",
        "conflictsWith"
      ]
    }
  },
  "required": [
    "id",
    "projectId",
    "type",
    "status",
    "title",
    "excerpt",
    "scope",
    "pinned",
    "currentRevision",
    "source",
    "createdAt",
    "updatedAt",
    "expiresAt",
    "reviewAt",
    "supersededById",
    "stale",
    "conflictsWith",
    "content",
    "revisions",
    "events",
    "usedByRuns"
  ]
}
```

## `memory.create`

Channel `relay/v1/memory.create` · command · route `runner`

### Input

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "idempotencyKey": {
      "type": "string",
      "minLength": 10,
      "maxLength": 64
    },
    "projectId": {
      "type": "string",
      "pattern": "^prj_[0-7][0-9A-HJKMNP-TV-Z]{25}$"
    },
    "type": {
      "type": "string",
      "enum": [
        "user_rule",
        "project_decision",
        "source_reference"
      ]
    },
    "title": {
      "type": "string",
      "minLength": 1,
      "maxLength": 120
    },
    "content": {
      "type": "string",
      "minLength": 1,
      "maxLength": 4000
    },
    "scope": {
      "type": "object",
      "properties": {
        "roles": {
          "anyOf": [
            {
              "minItems": 1,
              "type": "array",
              "items": {
                "type": "string",
                "enum": [
                  "reviewer",
                  "planner",
                  "implementer",
                  "verifier"
                ]
              }
            },
            {
              "type": "string",
              "const": "all"
            }
          ]
        }
      },
      "required": [
        "roles"
      ]
    },
    "expiresAt": {
      "type": "integer",
      "minimum": 0,
      "maximum": 9007199254740991
    },
    "reviewAt": {
      "type": "integer",
      "minimum": 0,
      "maximum": 9007199254740991
    },
    "pinned": {
      "type": "boolean"
    },
    "sourceFile": {
      "type": "object",
      "properties": {
        "relPath": {
          "type": "string",
          "minLength": 1,
          "maxLength": 512
        }
      },
      "required": [
        "relPath"
      ]
    }
  },
  "required": [
    "idempotencyKey",
    "projectId",
    "type",
    "title",
    "content",
    "scope"
  ]
}
```

### Output

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "id": {
      "type": "string",
      "pattern": "^mem_[0-7][0-9A-HJKMNP-TV-Z]{25}$"
    },
    "projectId": {
      "type": "string",
      "pattern": "^prj_[0-7][0-9A-HJKMNP-TV-Z]{25}$"
    },
    "type": {
      "type": "string",
      "enum": [
        "user_rule",
        "project_decision",
        "source_reference",
        "run_summary"
      ]
    },
    "status": {
      "type": "string",
      "enum": [
        "suggested",
        "approved",
        "archived",
        "rejected",
        "deleted"
      ]
    },
    "title": {
      "type": "string"
    },
    "excerpt": {
      "type": "string"
    },
    "scope": {
      "type": "object",
      "properties": {
        "roles": {
          "anyOf": [
            {
              "minItems": 1,
              "type": "array",
              "items": {
                "type": "string",
                "enum": [
                  "reviewer",
                  "planner",
                  "implementer",
                  "verifier"
                ]
              }
            },
            {
              "type": "string",
              "const": "all"
            }
          ]
        }
      },
      "required": [
        "roles"
      ]
    },
    "pinned": {
      "type": "boolean"
    },
    "currentRevision": {
      "type": "integer",
      "exclusiveMinimum": 0,
      "maximum": 9007199254740991
    },
    "source": {
      "oneOf": [
        {
          "type": "object",
          "properties": {
            "kind": {
              "type": "string",
              "const": "user"
            }
          },
          "required": [
            "kind"
          ]
        },
        {
          "type": "object",
          "properties": {
            "kind": {
              "type": "string",
              "const": "run"
            },
            "runId": {
              "type": "string",
              "pattern": "^run_[0-7][0-9A-HJKMNP-TV-Z]{25}$"
            },
            "artifactId": {
              "type": "string",
              "pattern": "^art_[0-7][0-9A-HJKMNP-TV-Z]{25}$"
            }
          },
          "required": [
            "kind",
            "runId"
          ]
        },
        {
          "type": "object",
          "properties": {
            "kind": {
              "type": "string",
              "const": "file"
            },
            "relPath": {
              "type": "string",
              "minLength": 1,
              "maxLength": 512
            }
          },
          "required": [
            "kind",
            "relPath"
          ]
        }
      ]
    },
    "createdAt": {
      "type": "integer",
      "minimum": 0,
      "maximum": 9007199254740991
    },
    "updatedAt": {
      "type": "integer",
      "minimum": 0,
      "maximum": 9007199254740991
    },
    "expiresAt": {
      "anyOf": [
        {
          "type": "integer",
          "minimum": 0,
          "maximum": 9007199254740991
        },
        {
          "type": "null"
        }
      ]
    },
    "reviewAt": {
      "anyOf": [
        {
          "type": "integer",
          "minimum": 0,
          "maximum": 9007199254740991
        },
        {
          "type": "null"
        }
      ]
    },
    "supersededById": {
      "anyOf": [
        {
          "type": "string",
          "pattern": "^mem_[0-7][0-9A-HJKMNP-TV-Z]{25}$"
        },
        {
          "type": "null"
        }
      ]
    },
    "stale": {
      "type": "boolean"
    },
    "conflictsWith": {
      "type": "array",
      "items": {
        "type": "string",
        "pattern": "^mem_[0-7][0-9A-HJKMNP-TV-Z]{25}$"
      }
    },
    "content": {
      "type": "string"
    },
    "revisions": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "revision": {
            "type": "integer",
            "exclusiveMinimum": 0,
            "maximum": 9007199254740991
          },
          "title": {
            "type": "string"
          },
          "content": {
            "type": "string"
          },
          "author": {
            "type": "string",
            "pattern": "^(user|run:run_[0-7][0-9A-HJKMNP-TV-Z]{25})$"
          },
          "createdAt": {
            "type": "integer",
            "minimum": 0,
            "maximum": 9007199254740991
          },
          "sourceRefs": {
            "type": "array",
            "items": {
              "oneOf": [
                {
                  "type": "object",
                  "properties": {
                    "kind": {
                      "type": "string",
                      "const": "file"
                    },
                    "relPath": {
                      "type": "string",
                      "minLength": 1,
                      "maxLength": 512
                    },
                    "sha256": {
                      "type": "string",
                      "pattern": "^[a-f0-9]{64}$"
                    }
                  },
                  "required": [
                    "kind",
                    "relPath",
                    "sha256"
                  ]
                },
                {
                  "type": "object",
                  "properties": {
                    "kind": {
                      "type": "string",
                      "const": "run"
                    },
                    "runId": {
                      "type": "string",
                      "pattern": "^run_[0-7][0-9A-HJKMNP-TV-Z]{25}$"
                    },
                    "artifactId": {
                      "anyOf": [
                        {
                          "type": "string",
                          "pattern": "^art_[0-7][0-9A-HJKMNP-TV-Z]{25}$"
                        },
                        {
                          "type": "null"
                        }
                      ]
                    }
                  },
                  "required": [
                    "kind",
                    "runId",
                    "artifactId"
                  ]
                }
              ]
            }
          }
        },
        "required": [
          "revision",
          "title",
          "content",
          "author",
          "createdAt",
          "sourceRefs"
        ]
      }
    },
    "events": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "event": {
            "type": "string",
            "enum": [
              "suggested",
              "approved",
              "edited",
              "archived",
              "rejected",
              "deleted",
              "conflict_resolved",
              "unarchived",
              "history_purged"
            ]
          },
          "revision": {
            "type": "integer",
            "exclusiveMinimum": 0,
            "maximum": 9007199254740991
          },
          "actor": {
            "type": "string",
            "pattern": "^(user|run:run_[0-7][0-9A-HJKMNP-TV-Z]{25})$"
          },
          "createdAt": {
            "type": "integer",
            "minimum": 0,
            "maximum": 9007199254740991
          }
        },
        "required": [
          "event",
          "revision",
          "actor",
          "createdAt"
        ]
      }
    },
    "usedByRuns": {
      "type": "integer",
      "minimum": 0,
      "maximum": 9007199254740991
    },
    "proposal": {
      "type": "object",
      "properties": {
        "rationale": {
          "type": "string"
        },
        "suggestedScope": {
          "type": "object",
          "properties": {
            "roles": {
              "anyOf": [
                {
                  "minItems": 1,
                  "type": "array",
                  "items": {
                    "type": "string",
                    "enum": [
                      "reviewer",
                      "planner",
                      "implementer",
                      "verifier"
                    ]
                  }
                },
                {
                  "type": "string",
                  "const": "all"
                }
              ]
            }
          },
          "required": [
            "roles"
          ]
        },
        "conflictsWith": {
          "type": "array",
          "items": {
            "type": "string",
            "pattern": "^mem_[0-7][0-9A-HJKMNP-TV-Z]{25}$"
          }
        }
      },
      "required": [
        "rationale",
        "suggestedScope",
        "conflictsWith"
      ]
    }
  },
  "required": [
    "id",
    "projectId",
    "type",
    "status",
    "title",
    "excerpt",
    "scope",
    "pinned",
    "currentRevision",
    "source",
    "createdAt",
    "updatedAt",
    "expiresAt",
    "reviewAt",
    "supersededById",
    "stale",
    "conflictsWith",
    "content",
    "revisions",
    "events",
    "usedByRuns"
  ]
}
```

## `memory.update`

Channel `relay/v1/memory.update` · command · route `runner`

### Input

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "recordId": {
      "type": "string",
      "pattern": "^mem_[0-7][0-9A-HJKMNP-TV-Z]{25}$"
    },
    "expectedRevision": {
      "type": "integer",
      "exclusiveMinimum": 0,
      "maximum": 9007199254740991
    },
    "title": {
      "type": "string",
      "minLength": 1,
      "maxLength": 120
    },
    "content": {
      "type": "string",
      "minLength": 1,
      "maxLength": 4000
    },
    "scope": {
      "type": "object",
      "properties": {
        "roles": {
          "anyOf": [
            {
              "minItems": 1,
              "type": "array",
              "items": {
                "type": "string",
                "enum": [
                  "reviewer",
                  "planner",
                  "implementer",
                  "verifier"
                ]
              }
            },
            {
              "type": "string",
              "const": "all"
            }
          ]
        }
      },
      "required": [
        "roles"
      ]
    },
    "expiresAt": {
      "anyOf": [
        {
          "type": "integer",
          "minimum": 0,
          "maximum": 9007199254740991
        },
        {
          "type": "null"
        }
      ]
    },
    "reviewAt": {
      "anyOf": [
        {
          "type": "integer",
          "minimum": 0,
          "maximum": 9007199254740991
        },
        {
          "type": "null"
        }
      ]
    },
    "pinned": {
      "type": "boolean"
    },
    "unarchive": {
      "type": "boolean",
      "const": true
    }
  },
  "required": [
    "recordId",
    "expectedRevision"
  ]
}
```

### Output

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "id": {
      "type": "string",
      "pattern": "^mem_[0-7][0-9A-HJKMNP-TV-Z]{25}$"
    },
    "projectId": {
      "type": "string",
      "pattern": "^prj_[0-7][0-9A-HJKMNP-TV-Z]{25}$"
    },
    "type": {
      "type": "string",
      "enum": [
        "user_rule",
        "project_decision",
        "source_reference",
        "run_summary"
      ]
    },
    "status": {
      "type": "string",
      "enum": [
        "suggested",
        "approved",
        "archived",
        "rejected",
        "deleted"
      ]
    },
    "title": {
      "type": "string"
    },
    "excerpt": {
      "type": "string"
    },
    "scope": {
      "type": "object",
      "properties": {
        "roles": {
          "anyOf": [
            {
              "minItems": 1,
              "type": "array",
              "items": {
                "type": "string",
                "enum": [
                  "reviewer",
                  "planner",
                  "implementer",
                  "verifier"
                ]
              }
            },
            {
              "type": "string",
              "const": "all"
            }
          ]
        }
      },
      "required": [
        "roles"
      ]
    },
    "pinned": {
      "type": "boolean"
    },
    "currentRevision": {
      "type": "integer",
      "exclusiveMinimum": 0,
      "maximum": 9007199254740991
    },
    "source": {
      "oneOf": [
        {
          "type": "object",
          "properties": {
            "kind": {
              "type": "string",
              "const": "user"
            }
          },
          "required": [
            "kind"
          ]
        },
        {
          "type": "object",
          "properties": {
            "kind": {
              "type": "string",
              "const": "run"
            },
            "runId": {
              "type": "string",
              "pattern": "^run_[0-7][0-9A-HJKMNP-TV-Z]{25}$"
            },
            "artifactId": {
              "type": "string",
              "pattern": "^art_[0-7][0-9A-HJKMNP-TV-Z]{25}$"
            }
          },
          "required": [
            "kind",
            "runId"
          ]
        },
        {
          "type": "object",
          "properties": {
            "kind": {
              "type": "string",
              "const": "file"
            },
            "relPath": {
              "type": "string",
              "minLength": 1,
              "maxLength": 512
            }
          },
          "required": [
            "kind",
            "relPath"
          ]
        }
      ]
    },
    "createdAt": {
      "type": "integer",
      "minimum": 0,
      "maximum": 9007199254740991
    },
    "updatedAt": {
      "type": "integer",
      "minimum": 0,
      "maximum": 9007199254740991
    },
    "expiresAt": {
      "anyOf": [
        {
          "type": "integer",
          "minimum": 0,
          "maximum": 9007199254740991
        },
        {
          "type": "null"
        }
      ]
    },
    "reviewAt": {
      "anyOf": [
        {
          "type": "integer",
          "minimum": 0,
          "maximum": 9007199254740991
        },
        {
          "type": "null"
        }
      ]
    },
    "supersededById": {
      "anyOf": [
        {
          "type": "string",
          "pattern": "^mem_[0-7][0-9A-HJKMNP-TV-Z]{25}$"
        },
        {
          "type": "null"
        }
      ]
    },
    "stale": {
      "type": "boolean"
    },
    "conflictsWith": {
      "type": "array",
      "items": {
        "type": "string",
        "pattern": "^mem_[0-7][0-9A-HJKMNP-TV-Z]{25}$"
      }
    },
    "content": {
      "type": "string"
    },
    "revisions": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "revision": {
            "type": "integer",
            "exclusiveMinimum": 0,
            "maximum": 9007199254740991
          },
          "title": {
            "type": "string"
          },
          "content": {
            "type": "string"
          },
          "author": {
            "type": "string",
            "pattern": "^(user|run:run_[0-7][0-9A-HJKMNP-TV-Z]{25})$"
          },
          "createdAt": {
            "type": "integer",
            "minimum": 0,
            "maximum": 9007199254740991
          },
          "sourceRefs": {
            "type": "array",
            "items": {
              "oneOf": [
                {
                  "type": "object",
                  "properties": {
                    "kind": {
                      "type": "string",
                      "const": "file"
                    },
                    "relPath": {
                      "type": "string",
                      "minLength": 1,
                      "maxLength": 512
                    },
                    "sha256": {
                      "type": "string",
                      "pattern": "^[a-f0-9]{64}$"
                    }
                  },
                  "required": [
                    "kind",
                    "relPath",
                    "sha256"
                  ]
                },
                {
                  "type": "object",
                  "properties": {
                    "kind": {
                      "type": "string",
                      "const": "run"
                    },
                    "runId": {
                      "type": "string",
                      "pattern": "^run_[0-7][0-9A-HJKMNP-TV-Z]{25}$"
                    },
                    "artifactId": {
                      "anyOf": [
                        {
                          "type": "string",
                          "pattern": "^art_[0-7][0-9A-HJKMNP-TV-Z]{25}$"
                        },
                        {
                          "type": "null"
                        }
                      ]
                    }
                  },
                  "required": [
                    "kind",
                    "runId",
                    "artifactId"
                  ]
                }
              ]
            }
          }
        },
        "required": [
          "revision",
          "title",
          "content",
          "author",
          "createdAt",
          "sourceRefs"
        ]
      }
    },
    "events": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "event": {
            "type": "string",
            "enum": [
              "suggested",
              "approved",
              "edited",
              "archived",
              "rejected",
              "deleted",
              "conflict_resolved",
              "unarchived",
              "history_purged"
            ]
          },
          "revision": {
            "type": "integer",
            "exclusiveMinimum": 0,
            "maximum": 9007199254740991
          },
          "actor": {
            "type": "string",
            "pattern": "^(user|run:run_[0-7][0-9A-HJKMNP-TV-Z]{25})$"
          },
          "createdAt": {
            "type": "integer",
            "minimum": 0,
            "maximum": 9007199254740991
          }
        },
        "required": [
          "event",
          "revision",
          "actor",
          "createdAt"
        ]
      }
    },
    "usedByRuns": {
      "type": "integer",
      "minimum": 0,
      "maximum": 9007199254740991
    },
    "proposal": {
      "type": "object",
      "properties": {
        "rationale": {
          "type": "string"
        },
        "suggestedScope": {
          "type": "object",
          "properties": {
            "roles": {
              "anyOf": [
                {
                  "minItems": 1,
                  "type": "array",
                  "items": {
                    "type": "string",
                    "enum": [
                      "reviewer",
                      "planner",
                      "implementer",
                      "verifier"
                    ]
                  }
                },
                {
                  "type": "string",
                  "const": "all"
                }
              ]
            }
          },
          "required": [
            "roles"
          ]
        },
        "conflictsWith": {
          "type": "array",
          "items": {
            "type": "string",
            "pattern": "^mem_[0-7][0-9A-HJKMNP-TV-Z]{25}$"
          }
        }
      },
      "required": [
        "rationale",
        "suggestedScope",
        "conflictsWith"
      ]
    }
  },
  "required": [
    "id",
    "projectId",
    "type",
    "status",
    "title",
    "excerpt",
    "scope",
    "pinned",
    "currentRevision",
    "source",
    "createdAt",
    "updatedAt",
    "expiresAt",
    "reviewAt",
    "supersededById",
    "stale",
    "conflictsWith",
    "content",
    "revisions",
    "events",
    "usedByRuns"
  ]
}
```

## `memory.approve`

Channel `relay/v1/memory.approve` · command · route `runner`

### Input

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "suggestionId": {
      "type": "string",
      "pattern": "^mem_[0-7][0-9A-HJKMNP-TV-Z]{25}$"
    },
    "expectedRevision": {
      "type": "integer",
      "exclusiveMinimum": 0,
      "maximum": 9007199254740991
    },
    "finalContent": {
      "type": "string",
      "minLength": 1,
      "maxLength": 4000
    },
    "finalTitle": {
      "type": "string",
      "minLength": 1,
      "maxLength": 120
    },
    "scope": {
      "type": "object",
      "properties": {
        "roles": {
          "anyOf": [
            {
              "minItems": 1,
              "type": "array",
              "items": {
                "type": "string",
                "enum": [
                  "reviewer",
                  "planner",
                  "implementer",
                  "verifier"
                ]
              }
            },
            {
              "type": "string",
              "const": "all"
            }
          ]
        }
      },
      "required": [
        "roles"
      ]
    },
    "pinned": {
      "type": "boolean"
    }
  },
  "required": [
    "suggestionId",
    "expectedRevision"
  ]
}
```

### Output

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "id": {
      "type": "string",
      "pattern": "^mem_[0-7][0-9A-HJKMNP-TV-Z]{25}$"
    },
    "projectId": {
      "type": "string",
      "pattern": "^prj_[0-7][0-9A-HJKMNP-TV-Z]{25}$"
    },
    "type": {
      "type": "string",
      "enum": [
        "user_rule",
        "project_decision",
        "source_reference",
        "run_summary"
      ]
    },
    "status": {
      "type": "string",
      "enum": [
        "suggested",
        "approved",
        "archived",
        "rejected",
        "deleted"
      ]
    },
    "title": {
      "type": "string"
    },
    "excerpt": {
      "type": "string"
    },
    "scope": {
      "type": "object",
      "properties": {
        "roles": {
          "anyOf": [
            {
              "minItems": 1,
              "type": "array",
              "items": {
                "type": "string",
                "enum": [
                  "reviewer",
                  "planner",
                  "implementer",
                  "verifier"
                ]
              }
            },
            {
              "type": "string",
              "const": "all"
            }
          ]
        }
      },
      "required": [
        "roles"
      ]
    },
    "pinned": {
      "type": "boolean"
    },
    "currentRevision": {
      "type": "integer",
      "exclusiveMinimum": 0,
      "maximum": 9007199254740991
    },
    "source": {
      "oneOf": [
        {
          "type": "object",
          "properties": {
            "kind": {
              "type": "string",
              "const": "user"
            }
          },
          "required": [
            "kind"
          ]
        },
        {
          "type": "object",
          "properties": {
            "kind": {
              "type": "string",
              "const": "run"
            },
            "runId": {
              "type": "string",
              "pattern": "^run_[0-7][0-9A-HJKMNP-TV-Z]{25}$"
            },
            "artifactId": {
              "type": "string",
              "pattern": "^art_[0-7][0-9A-HJKMNP-TV-Z]{25}$"
            }
          },
          "required": [
            "kind",
            "runId"
          ]
        },
        {
          "type": "object",
          "properties": {
            "kind": {
              "type": "string",
              "const": "file"
            },
            "relPath": {
              "type": "string",
              "minLength": 1,
              "maxLength": 512
            }
          },
          "required": [
            "kind",
            "relPath"
          ]
        }
      ]
    },
    "createdAt": {
      "type": "integer",
      "minimum": 0,
      "maximum": 9007199254740991
    },
    "updatedAt": {
      "type": "integer",
      "minimum": 0,
      "maximum": 9007199254740991
    },
    "expiresAt": {
      "anyOf": [
        {
          "type": "integer",
          "minimum": 0,
          "maximum": 9007199254740991
        },
        {
          "type": "null"
        }
      ]
    },
    "reviewAt": {
      "anyOf": [
        {
          "type": "integer",
          "minimum": 0,
          "maximum": 9007199254740991
        },
        {
          "type": "null"
        }
      ]
    },
    "supersededById": {
      "anyOf": [
        {
          "type": "string",
          "pattern": "^mem_[0-7][0-9A-HJKMNP-TV-Z]{25}$"
        },
        {
          "type": "null"
        }
      ]
    },
    "stale": {
      "type": "boolean"
    },
    "conflictsWith": {
      "type": "array",
      "items": {
        "type": "string",
        "pattern": "^mem_[0-7][0-9A-HJKMNP-TV-Z]{25}$"
      }
    },
    "content": {
      "type": "string"
    },
    "revisions": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "revision": {
            "type": "integer",
            "exclusiveMinimum": 0,
            "maximum": 9007199254740991
          },
          "title": {
            "type": "string"
          },
          "content": {
            "type": "string"
          },
          "author": {
            "type": "string",
            "pattern": "^(user|run:run_[0-7][0-9A-HJKMNP-TV-Z]{25})$"
          },
          "createdAt": {
            "type": "integer",
            "minimum": 0,
            "maximum": 9007199254740991
          },
          "sourceRefs": {
            "type": "array",
            "items": {
              "oneOf": [
                {
                  "type": "object",
                  "properties": {
                    "kind": {
                      "type": "string",
                      "const": "file"
                    },
                    "relPath": {
                      "type": "string",
                      "minLength": 1,
                      "maxLength": 512
                    },
                    "sha256": {
                      "type": "string",
                      "pattern": "^[a-f0-9]{64}$"
                    }
                  },
                  "required": [
                    "kind",
                    "relPath",
                    "sha256"
                  ]
                },
                {
                  "type": "object",
                  "properties": {
                    "kind": {
                      "type": "string",
                      "const": "run"
                    },
                    "runId": {
                      "type": "string",
                      "pattern": "^run_[0-7][0-9A-HJKMNP-TV-Z]{25}$"
                    },
                    "artifactId": {
                      "anyOf": [
                        {
                          "type": "string",
                          "pattern": "^art_[0-7][0-9A-HJKMNP-TV-Z]{25}$"
                        },
                        {
                          "type": "null"
                        }
                      ]
                    }
                  },
                  "required": [
                    "kind",
                    "runId",
                    "artifactId"
                  ]
                }
              ]
            }
          }
        },
        "required": [
          "revision",
          "title",
          "content",
          "author",
          "createdAt",
          "sourceRefs"
        ]
      }
    },
    "events": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "event": {
            "type": "string",
            "enum": [
              "suggested",
              "approved",
              "edited",
              "archived",
              "rejected",
              "deleted",
              "conflict_resolved",
              "unarchived",
              "history_purged"
            ]
          },
          "revision": {
            "type": "integer",
            "exclusiveMinimum": 0,
            "maximum": 9007199254740991
          },
          "actor": {
            "type": "string",
            "pattern": "^(user|run:run_[0-7][0-9A-HJKMNP-TV-Z]{25})$"
          },
          "createdAt": {
            "type": "integer",
            "minimum": 0,
            "maximum": 9007199254740991
          }
        },
        "required": [
          "event",
          "revision",
          "actor",
          "createdAt"
        ]
      }
    },
    "usedByRuns": {
      "type": "integer",
      "minimum": 0,
      "maximum": 9007199254740991
    },
    "proposal": {
      "type": "object",
      "properties": {
        "rationale": {
          "type": "string"
        },
        "suggestedScope": {
          "type": "object",
          "properties": {
            "roles": {
              "anyOf": [
                {
                  "minItems": 1,
                  "type": "array",
                  "items": {
                    "type": "string",
                    "enum": [
                      "reviewer",
                      "planner",
                      "implementer",
                      "verifier"
                    ]
                  }
                },
                {
                  "type": "string",
                  "const": "all"
                }
              ]
            }
          },
          "required": [
            "roles"
          ]
        },
        "conflictsWith": {
          "type": "array",
          "items": {
            "type": "string",
            "pattern": "^mem_[0-7][0-9A-HJKMNP-TV-Z]{25}$"
          }
        }
      },
      "required": [
        "rationale",
        "suggestedScope",
        "conflictsWith"
      ]
    }
  },
  "required": [
    "id",
    "projectId",
    "type",
    "status",
    "title",
    "excerpt",
    "scope",
    "pinned",
    "currentRevision",
    "source",
    "createdAt",
    "updatedAt",
    "expiresAt",
    "reviewAt",
    "supersededById",
    "stale",
    "conflictsWith",
    "content",
    "revisions",
    "events",
    "usedByRuns"
  ]
}
```

## `memory.reject`

Channel `relay/v1/memory.reject` · command · route `runner`

### Input

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "suggestionId": {
      "type": "string",
      "pattern": "^mem_[0-7][0-9A-HJKMNP-TV-Z]{25}$"
    },
    "reason": {
      "type": "string",
      "maxLength": 400
    }
  },
  "required": [
    "suggestionId"
  ]
}
```

### Output

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "status": {
      "type": "string",
      "const": "rejected"
    }
  },
  "required": [
    "status"
  ]
}
```

## `memory.archive`

Channel `relay/v1/memory.archive` · command · route `runner`

### Input

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "recordId": {
      "type": "string",
      "pattern": "^mem_[0-7][0-9A-HJKMNP-TV-Z]{25}$"
    }
  },
  "required": [
    "recordId"
  ]
}
```

### Output

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "id": {
      "type": "string",
      "pattern": "^mem_[0-7][0-9A-HJKMNP-TV-Z]{25}$"
    },
    "projectId": {
      "type": "string",
      "pattern": "^prj_[0-7][0-9A-HJKMNP-TV-Z]{25}$"
    },
    "type": {
      "type": "string",
      "enum": [
        "user_rule",
        "project_decision",
        "source_reference",
        "run_summary"
      ]
    },
    "status": {
      "type": "string",
      "enum": [
        "suggested",
        "approved",
        "archived",
        "rejected",
        "deleted"
      ]
    },
    "title": {
      "type": "string"
    },
    "excerpt": {
      "type": "string"
    },
    "scope": {
      "type": "object",
      "properties": {
        "roles": {
          "anyOf": [
            {
              "minItems": 1,
              "type": "array",
              "items": {
                "type": "string",
                "enum": [
                  "reviewer",
                  "planner",
                  "implementer",
                  "verifier"
                ]
              }
            },
            {
              "type": "string",
              "const": "all"
            }
          ]
        }
      },
      "required": [
        "roles"
      ]
    },
    "pinned": {
      "type": "boolean"
    },
    "currentRevision": {
      "type": "integer",
      "exclusiveMinimum": 0,
      "maximum": 9007199254740991
    },
    "source": {
      "oneOf": [
        {
          "type": "object",
          "properties": {
            "kind": {
              "type": "string",
              "const": "user"
            }
          },
          "required": [
            "kind"
          ]
        },
        {
          "type": "object",
          "properties": {
            "kind": {
              "type": "string",
              "const": "run"
            },
            "runId": {
              "type": "string",
              "pattern": "^run_[0-7][0-9A-HJKMNP-TV-Z]{25}$"
            },
            "artifactId": {
              "type": "string",
              "pattern": "^art_[0-7][0-9A-HJKMNP-TV-Z]{25}$"
            }
          },
          "required": [
            "kind",
            "runId"
          ]
        },
        {
          "type": "object",
          "properties": {
            "kind": {
              "type": "string",
              "const": "file"
            },
            "relPath": {
              "type": "string",
              "minLength": 1,
              "maxLength": 512
            }
          },
          "required": [
            "kind",
            "relPath"
          ]
        }
      ]
    },
    "createdAt": {
      "type": "integer",
      "minimum": 0,
      "maximum": 9007199254740991
    },
    "updatedAt": {
      "type": "integer",
      "minimum": 0,
      "maximum": 9007199254740991
    },
    "expiresAt": {
      "anyOf": [
        {
          "type": "integer",
          "minimum": 0,
          "maximum": 9007199254740991
        },
        {
          "type": "null"
        }
      ]
    },
    "reviewAt": {
      "anyOf": [
        {
          "type": "integer",
          "minimum": 0,
          "maximum": 9007199254740991
        },
        {
          "type": "null"
        }
      ]
    },
    "supersededById": {
      "anyOf": [
        {
          "type": "string",
          "pattern": "^mem_[0-7][0-9A-HJKMNP-TV-Z]{25}$"
        },
        {
          "type": "null"
        }
      ]
    },
    "stale": {
      "type": "boolean"
    },
    "conflictsWith": {
      "type": "array",
      "items": {
        "type": "string",
        "pattern": "^mem_[0-7][0-9A-HJKMNP-TV-Z]{25}$"
      }
    },
    "content": {
      "type": "string"
    },
    "revisions": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "revision": {
            "type": "integer",
            "exclusiveMinimum": 0,
            "maximum": 9007199254740991
          },
          "title": {
            "type": "string"
          },
          "content": {
            "type": "string"
          },
          "author": {
            "type": "string",
            "pattern": "^(user|run:run_[0-7][0-9A-HJKMNP-TV-Z]{25})$"
          },
          "createdAt": {
            "type": "integer",
            "minimum": 0,
            "maximum": 9007199254740991
          },
          "sourceRefs": {
            "type": "array",
            "items": {
              "oneOf": [
                {
                  "type": "object",
                  "properties": {
                    "kind": {
                      "type": "string",
                      "const": "file"
                    },
                    "relPath": {
                      "type": "string",
                      "minLength": 1,
                      "maxLength": 512
                    },
                    "sha256": {
                      "type": "string",
                      "pattern": "^[a-f0-9]{64}$"
                    }
                  },
                  "required": [
                    "kind",
                    "relPath",
                    "sha256"
                  ]
                },
                {
                  "type": "object",
                  "properties": {
                    "kind": {
                      "type": "string",
                      "const": "run"
                    },
                    "runId": {
                      "type": "string",
                      "pattern": "^run_[0-7][0-9A-HJKMNP-TV-Z]{25}$"
                    },
                    "artifactId": {
                      "anyOf": [
                        {
                          "type": "string",
                          "pattern": "^art_[0-7][0-9A-HJKMNP-TV-Z]{25}$"
                        },
                        {
                          "type": "null"
                        }
                      ]
                    }
                  },
                  "required": [
                    "kind",
                    "runId",
                    "artifactId"
                  ]
                }
              ]
            }
          }
        },
        "required": [
          "revision",
          "title",
          "content",
          "author",
          "createdAt",
          "sourceRefs"
        ]
      }
    },
    "events": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "event": {
            "type": "string",
            "enum": [
              "suggested",
              "approved",
              "edited",
              "archived",
              "rejected",
              "deleted",
              "conflict_resolved",
              "unarchived",
              "history_purged"
            ]
          },
          "revision": {
            "type": "integer",
            "exclusiveMinimum": 0,
            "maximum": 9007199254740991
          },
          "actor": {
            "type": "string",
            "pattern": "^(user|run:run_[0-7][0-9A-HJKMNP-TV-Z]{25})$"
          },
          "createdAt": {
            "type": "integer",
            "minimum": 0,
            "maximum": 9007199254740991
          }
        },
        "required": [
          "event",
          "revision",
          "actor",
          "createdAt"
        ]
      }
    },
    "usedByRuns": {
      "type": "integer",
      "minimum": 0,
      "maximum": 9007199254740991
    },
    "proposal": {
      "type": "object",
      "properties": {
        "rationale": {
          "type": "string"
        },
        "suggestedScope": {
          "type": "object",
          "properties": {
            "roles": {
              "anyOf": [
                {
                  "minItems": 1,
                  "type": "array",
                  "items": {
                    "type": "string",
                    "enum": [
                      "reviewer",
                      "planner",
                      "implementer",
                      "verifier"
                    ]
                  }
                },
                {
                  "type": "string",
                  "const": "all"
                }
              ]
            }
          },
          "required": [
            "roles"
          ]
        },
        "conflictsWith": {
          "type": "array",
          "items": {
            "type": "string",
            "pattern": "^mem_[0-7][0-9A-HJKMNP-TV-Z]{25}$"
          }
        }
      },
      "required": [
        "rationale",
        "suggestedScope",
        "conflictsWith"
      ]
    }
  },
  "required": [
    "id",
    "projectId",
    "type",
    "status",
    "title",
    "excerpt",
    "scope",
    "pinned",
    "currentRevision",
    "source",
    "createdAt",
    "updatedAt",
    "expiresAt",
    "reviewAt",
    "supersededById",
    "stale",
    "conflictsWith",
    "content",
    "revisions",
    "events",
    "usedByRuns"
  ]
}
```

## `memory.delete`

Channel `relay/v1/memory.delete` · command · route `runner`

### Input

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "recordId": {
      "type": "string",
      "pattern": "^mem_[0-7][0-9A-HJKMNP-TV-Z]{25}$"
    },
    "confirm": {
      "type": "boolean",
      "const": true
    }
  },
  "required": [
    "recordId",
    "confirm"
  ]
}
```

### Output

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "deleted": {
      "type": "boolean",
      "const": true
    },
    "retainedInRunSnapshots": {
      "type": "integer",
      "minimum": 0,
      "maximum": 9007199254740991
    }
  },
  "required": [
    "deleted",
    "retainedInRunSnapshots"
  ]
}
```

## `memory.resolveConflict`

Channel `relay/v1/memory.resolveConflict` · command · route `runner`

### Input

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "idempotencyKey": {
      "type": "string",
      "minLength": 10,
      "maxLength": 64
    },
    "recordIds": {
      "type": "array",
      "prefixItems": [
        {
          "type": "string",
          "pattern": "^mem_[0-7][0-9A-HJKMNP-TV-Z]{25}$"
        },
        {
          "type": "string",
          "pattern": "^mem_[0-7][0-9A-HJKMNP-TV-Z]{25}$"
        }
      ],
      "items": false,
      "minItems": 2,
      "maxItems": 2
    },
    "resolution": {
      "anyOf": [
        {
          "type": "object",
          "properties": {
            "keep": {
              "type": "string",
              "pattern": "^mem_[0-7][0-9A-HJKMNP-TV-Z]{25}$"
            }
          },
          "required": [
            "keep"
          ]
        },
        {
          "type": "object",
          "properties": {
            "rewrite": {
              "type": "object",
              "properties": {
                "title": {
                  "type": "string",
                  "minLength": 1,
                  "maxLength": 120
                },
                "content": {
                  "type": "string",
                  "minLength": 1,
                  "maxLength": 4000
                },
                "scope": {
                  "type": "object",
                  "properties": {
                    "roles": {
                      "anyOf": [
                        {
                          "minItems": 1,
                          "type": "array",
                          "items": {
                            "type": "string",
                            "enum": [
                              "reviewer",
                              "planner",
                              "implementer",
                              "verifier"
                            ]
                          }
                        },
                        {
                          "type": "string",
                          "const": "all"
                        }
                      ]
                    }
                  },
                  "required": [
                    "roles"
                  ]
                },
                "pinned": {
                  "type": "boolean"
                }
              },
              "required": [
                "title",
                "content",
                "scope"
              ]
            }
          },
          "required": [
            "rewrite"
          ]
        },
        {
          "type": "object",
          "properties": {
            "keepBothWithScopes": {
              "type": "array",
              "prefixItems": [
                {
                  "type": "object",
                  "properties": {
                    "recordId": {
                      "type": "string",
                      "pattern": "^mem_[0-7][0-9A-HJKMNP-TV-Z]{25}$"
                    },
                    "scope": {
                      "type": "object",
                      "properties": {
                        "roles": {
                          "anyOf": [
                            {
                              "minItems": 1,
                              "type": "array",
                              "items": {
                                "type": "string",
                                "enum": [
                                  "reviewer",
                                  "planner",
                                  "implementer",
                                  "verifier"
                                ]
                              }
                            },
                            {
                              "type": "string",
                              "const": "all"
                            }
                          ]
                        }
                      },
                      "required": [
                        "roles"
                      ]
                    }
                  },
                  "required": [
                    "recordId",
                    "scope"
                  ]
                },
                {
                  "type": "object",
                  "properties": {
                    "recordId": {
                      "type": "string",
                      "pattern": "^mem_[0-7][0-9A-HJKMNP-TV-Z]{25}$"
                    },
                    "scope": {
                      "type": "object",
                      "properties": {
                        "roles": {
                          "anyOf": [
                            {
                              "minItems": 1,
                              "type": "array",
                              "items": {
                                "type": "string",
                                "enum": [
                                  "reviewer",
                                  "planner",
                                  "implementer",
                                  "verifier"
                                ]
                              }
                            },
                            {
                              "type": "string",
                              "const": "all"
                            }
                          ]
                        }
                      },
                      "required": [
                        "roles"
                      ]
                    }
                  },
                  "required": [
                    "recordId",
                    "scope"
                  ]
                }
              ],
              "items": false,
              "minItems": 2,
              "maxItems": 2
            }
          },
          "required": [
            "keepBothWithScopes"
          ]
        }
      ]
    }
  },
  "required": [
    "idempotencyKey",
    "recordIds",
    "resolution"
  ]
}
```

### Output

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "array",
  "items": {
    "type": "object",
    "properties": {
      "id": {
        "type": "string",
        "pattern": "^mem_[0-7][0-9A-HJKMNP-TV-Z]{25}$"
      },
      "projectId": {
        "type": "string",
        "pattern": "^prj_[0-7][0-9A-HJKMNP-TV-Z]{25}$"
      },
      "type": {
        "type": "string",
        "enum": [
          "user_rule",
          "project_decision",
          "source_reference",
          "run_summary"
        ]
      },
      "status": {
        "type": "string",
        "enum": [
          "suggested",
          "approved",
          "archived",
          "rejected",
          "deleted"
        ]
      },
      "title": {
        "type": "string"
      },
      "excerpt": {
        "type": "string"
      },
      "scope": {
        "type": "object",
        "properties": {
          "roles": {
            "anyOf": [
              {
                "minItems": 1,
                "type": "array",
                "items": {
                  "type": "string",
                  "enum": [
                    "reviewer",
                    "planner",
                    "implementer",
                    "verifier"
                  ]
                }
              },
              {
                "type": "string",
                "const": "all"
              }
            ]
          }
        },
        "required": [
          "roles"
        ]
      },
      "pinned": {
        "type": "boolean"
      },
      "currentRevision": {
        "type": "integer",
        "exclusiveMinimum": 0,
        "maximum": 9007199254740991
      },
      "source": {
        "oneOf": [
          {
            "type": "object",
            "properties": {
              "kind": {
                "type": "string",
                "const": "user"
              }
            },
            "required": [
              "kind"
            ]
          },
          {
            "type": "object",
            "properties": {
              "kind": {
                "type": "string",
                "const": "run"
              },
              "runId": {
                "type": "string",
                "pattern": "^run_[0-7][0-9A-HJKMNP-TV-Z]{25}$"
              },
              "artifactId": {
                "type": "string",
                "pattern": "^art_[0-7][0-9A-HJKMNP-TV-Z]{25}$"
              }
            },
            "required": [
              "kind",
              "runId"
            ]
          },
          {
            "type": "object",
            "properties": {
              "kind": {
                "type": "string",
                "const": "file"
              },
              "relPath": {
                "type": "string",
                "minLength": 1,
                "maxLength": 512
              }
            },
            "required": [
              "kind",
              "relPath"
            ]
          }
        ]
      },
      "createdAt": {
        "type": "integer",
        "minimum": 0,
        "maximum": 9007199254740991
      },
      "updatedAt": {
        "type": "integer",
        "minimum": 0,
        "maximum": 9007199254740991
      },
      "expiresAt": {
        "anyOf": [
          {
            "type": "integer",
            "minimum": 0,
            "maximum": 9007199254740991
          },
          {
            "type": "null"
          }
        ]
      },
      "reviewAt": {
        "anyOf": [
          {
            "type": "integer",
            "minimum": 0,
            "maximum": 9007199254740991
          },
          {
            "type": "null"
          }
        ]
      },
      "supersededById": {
        "anyOf": [
          {
            "type": "string",
            "pattern": "^mem_[0-7][0-9A-HJKMNP-TV-Z]{25}$"
          },
          {
            "type": "null"
          }
        ]
      },
      "stale": {
        "type": "boolean"
      },
      "conflictsWith": {
        "type": "array",
        "items": {
          "type": "string",
          "pattern": "^mem_[0-7][0-9A-HJKMNP-TV-Z]{25}$"
        }
      }
    },
    "required": [
      "id",
      "projectId",
      "type",
      "status",
      "title",
      "excerpt",
      "scope",
      "pinned",
      "currentRevision",
      "source",
      "createdAt",
      "updatedAt",
      "expiresAt",
      "reviewAt",
      "supersededById",
      "stale",
      "conflictsWith"
    ]
  }
}
```

## `memory.purgeProjectHistory`

Channel `relay/v1/memory.purgeProjectHistory` · command · route `runner`

### Input

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "projectId": {
      "type": "string",
      "pattern": "^prj_[0-7][0-9A-HJKMNP-TV-Z]{25}$"
    },
    "confirmPhrase": {
      "type": "string",
      "const": "purge"
    }
  },
  "required": [
    "projectId",
    "confirmPhrase"
  ]
}
```

### Output

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "purgedSnapshots": {
      "type": "integer",
      "minimum": 0,
      "maximum": 9007199254740991
    },
    "purgedArtifacts": {
      "type": "integer",
      "minimum": 0,
      "maximum": 9007199254740991
    },
    "failed": {
      "type": "integer",
      "minimum": 0,
      "maximum": 9007199254740991
    }
  },
  "required": [
    "purgedSnapshots"
  ]
}
```

## `artifacts.get`

Channel `relay/v1/artifacts.get` · query · route `runner`

### Input

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "artifactId": {
      "type": "string",
      "pattern": "^art_[0-7][0-9A-HJKMNP-TV-Z]{25}$"
    },
    "maxBytes": {
      "type": "integer",
      "exclusiveMinimum": 0,
      "maximum": 2097152
    }
  },
  "required": [
    "artifactId"
  ]
}
```

### Output

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "meta": {
      "type": "object",
      "properties": {
        "id": {
          "type": "string",
          "pattern": "^art_[0-7][0-9A-HJKMNP-TV-Z]{25}$"
        },
        "kind": {
          "type": "string",
          "enum": [
            "context_manifest",
            "raw_response",
            "findings",
            "plan",
            "patch",
            "review",
            "report",
            "memory_suggestions",
            "input_diff",
            "input_file"
          ]
        },
        "schemaId": {
          "type": [
            "string",
            "null"
          ]
        },
        "runId": {
          "anyOf": [
            {
              "type": "string",
              "pattern": "^run_[0-7][0-9A-HJKMNP-TV-Z]{25}$"
            },
            {
              "type": "null"
            }
          ]
        },
        "stepRunId": {
          "anyOf": [
            {
              "type": "string",
              "pattern": "^stp_[0-7][0-9A-HJKMNP-TV-Z]{25}$"
            },
            {
              "type": "null"
            }
          ]
        },
        "attemptId": {
          "anyOf": [
            {
              "type": "string",
              "pattern": "^att_[0-7][0-9A-HJKMNP-TV-Z]{25}$"
            },
            {
              "type": "null"
            }
          ]
        },
        "sha256": {
          "type": "string",
          "pattern": "^[a-f0-9]{64}$"
        },
        "sizeBytes": {
          "type": "integer",
          "minimum": 0,
          "maximum": 9007199254740991
        },
        "mediaType": {
          "type": "string"
        },
        "createdAt": {
          "type": "integer",
          "minimum": 0,
          "maximum": 9007199254740991
        },
        "purged": {
          "type": "boolean"
        }
      },
      "required": [
        "id",
        "kind",
        "schemaId",
        "runId",
        "stepRunId",
        "attemptId",
        "sha256",
        "sizeBytes",
        "mediaType",
        "createdAt",
        "purged"
      ]
    },
    "content": {
      "oneOf": [
        {
          "type": "object",
          "properties": {
            "kind": {
              "type": "string",
              "const": "json"
            },
            "value": {}
          },
          "required": [
            "kind",
            "value"
          ]
        },
        {
          "type": "object",
          "properties": {
            "kind": {
              "type": "string",
              "const": "text"
            },
            "text": {
              "type": "string"
            },
            "truncated": {
              "type": "boolean"
            }
          },
          "required": [
            "kind",
            "text",
            "truncated"
          ]
        }
      ]
    }
  },
  "required": [
    "meta",
    "content"
  ]
}
```

## `artifacts.importDiff`

Channel `relay/v1/artifacts.importDiff` · command · route `main+runner`

### Input

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "projectId": {
      "type": "string",
      "pattern": "^prj_[0-7][0-9A-HJKMNP-TV-Z]{25}$"
    }
  },
  "required": [
    "projectId"
  ]
}
```

### Output

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "anyOf": [
    {
      "type": "object",
      "properties": {
        "artifactId": {
          "type": "string",
          "pattern": "^art_[0-7][0-9A-HJKMNP-TV-Z]{25}$"
        },
        "files": {
          "type": "array",
          "items": {
            "type": "string"
          }
        },
        "parseWarnings": {
          "type": "array",
          "items": {
            "type": "string"
          }
        }
      },
      "required": [
        "artifactId",
        "files",
        "parseWarnings"
      ]
    },
    {
      "type": "null"
    }
  ]
}
```

## `artifacts.export`

Channel `relay/v1/artifacts.export` · command · route `main+runner`

### Input

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "runId": {
      "type": "string",
      "pattern": "^run_[0-7][0-9A-HJKMNP-TV-Z]{25}$"
    },
    "what": {
      "type": "string",
      "enum": [
        "report",
        "patch",
        "both"
      ]
    }
  },
  "required": [
    "runId",
    "what"
  ]
}
```

### Output

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "exported": {
      "type": "boolean"
    },
    "displayPaths": {
      "type": "array",
      "items": {
        "type": "string"
      }
    }
  },
  "required": [
    "exported",
    "displayPaths"
  ]
}
```

## `ledger.runSummary`

Channel `relay/v1/ledger.runSummary` · query · route `runner`

### Input

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "runId": {
      "type": "string",
      "pattern": "^run_[0-7][0-9A-HJKMNP-TV-Z]{25}$"
    }
  },
  "required": [
    "runId"
  ]
}
```

### Output

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "allowance": {
      "type": "integer",
      "minimum": -9007199254740991,
      "maximum": 9007199254740991
    },
    "settledReported": {
      "type": "integer",
      "minimum": -9007199254740991,
      "maximum": 9007199254740991
    },
    "settledCalculated": {
      "type": "integer",
      "minimum": -9007199254740991,
      "maximum": 9007199254740991
    },
    "settledEstimated": {
      "type": "integer",
      "minimum": -9007199254740991,
      "maximum": 9007199254740991
    },
    "reserved": {
      "type": "integer",
      "minimum": -9007199254740991,
      "maximum": 9007199254740991
    },
    "unknown": {
      "type": "integer",
      "minimum": -9007199254740991,
      "maximum": 9007199254740991
    },
    "remaining": {
      "type": "integer",
      "minimum": -9007199254740991,
      "maximum": 9007199254740991
    },
    "overrun": {
      "type": "boolean"
    },
    "byStep": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "stepKey": {
            "type": "string",
            "pattern": "^[a-z][a-z0-9_-]{0,31}$"
          },
          "cost": {
            "type": "object",
            "properties": {
              "allowance": {
                "type": "integer",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991
              },
              "settledReported": {
                "type": "integer",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991
              },
              "settledCalculated": {
                "type": "integer",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991
              },
              "settledEstimated": {
                "type": "integer",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991
              },
              "reserved": {
                "type": "integer",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991
              },
              "unknown": {
                "type": "integer",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991
              },
              "remaining": {
                "type": "integer",
                "minimum": -9007199254740991,
                "maximum": 9007199254740991
              },
              "overrun": {
                "type": "boolean"
              }
            },
            "required": [
              "allowance",
              "settledReported",
              "settledCalculated",
              "settledEstimated",
              "reserved",
              "unknown",
              "remaining",
              "overrun"
            ]
          }
        },
        "required": [
          "stepKey",
          "cost"
        ]
      }
    }
  },
  "required": [
    "allowance",
    "settledReported",
    "settledCalculated",
    "settledEstimated",
    "reserved",
    "unknown",
    "remaining",
    "overrun",
    "byStep"
  ]
}
```

## `ledger.projectSummary`

Channel `relay/v1/ledger.projectSummary` · query · route `runner`

### Input

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "projectId": {
      "type": "string",
      "pattern": "^prj_[0-7][0-9A-HJKMNP-TV-Z]{25}$"
    },
    "month": {
      "type": "string",
      "pattern": "^\\d{4}-(0[1-9]|1[0-2])$"
    }
  },
  "required": [
    "projectId"
  ]
}
```

### Output

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "trackedMicrousd": {
      "type": "integer",
      "minimum": -9007199254740991,
      "maximum": 9007199254740991
    },
    "reservedMicrousd": {
      "type": "integer",
      "minimum": -9007199254740991,
      "maximum": 9007199254740991
    },
    "unknownMicrousd": {
      "type": "integer",
      "minimum": -9007199254740991,
      "maximum": 9007199254740991
    },
    "allowance": {
      "anyOf": [
        {
          "type": "integer",
          "minimum": -9007199254740991,
          "maximum": 9007199254740991
        },
        {
          "type": "null"
        }
      ]
    },
    "label": {
      "type": "string",
      "const": "tracked by Relay"
    }
  },
  "required": [
    "trackedMicrousd",
    "reservedMicrousd",
    "unknownMicrousd",
    "allowance",
    "label"
  ]
}
```

## `ledger.entries`

Channel `relay/v1/ledger.entries` · query · route `runner`

### Input

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "runId": {
      "type": "string",
      "pattern": "^run_[0-7][0-9A-HJKMNP-TV-Z]{25}$"
    },
    "limit": {
      "default": 25,
      "type": "integer",
      "minimum": 1,
      "maximum": 100
    },
    "cursor": {
      "type": "string",
      "minLength": 1,
      "maxLength": 512
    }
  },
  "required": [
    "runId"
  ]
}
```

### Output

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "items": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "id": {
            "type": "string",
            "pattern": "^led_[0-7][0-9A-HJKMNP-TV-Z]{25}$"
          },
          "createdAt": {
            "type": "integer",
            "minimum": 0,
            "maximum": 9007199254740991
          },
          "scope": {
            "type": "string",
            "enum": [
              "run",
              "setup"
            ]
          },
          "runId": {
            "anyOf": [
              {
                "type": "string",
                "pattern": "^run_[0-7][0-9A-HJKMNP-TV-Z]{25}$"
              },
              {
                "type": "null"
              }
            ]
          },
          "stepKey": {
            "anyOf": [
              {
                "type": "string",
                "pattern": "^[a-z][a-z0-9_-]{0,31}$"
              },
              {
                "type": "null"
              }
            ]
          },
          "attemptId": {
            "anyOf": [
              {
                "type": "string",
                "pattern": "^att_[0-7][0-9A-HJKMNP-TV-Z]{25}$"
              },
              {
                "type": "null"
              }
            ]
          },
          "type": {
            "type": "string",
            "enum": [
              "allowance_set",
              "allowance_change",
              "reserve",
              "release",
              "settle",
              "move_to_unknown",
              "resolve_unknown"
            ]
          },
          "bucket": {
            "type": "string",
            "enum": [
              "allowance",
              "reserved",
              "settled",
              "unknown"
            ]
          },
          "deltaMicrousd": {
            "type": "integer",
            "minimum": -9007199254740991,
            "maximum": 9007199254740991
          },
          "certainty": {
            "anyOf": [
              {
                "type": "string",
                "enum": [
                  "reported",
                  "calculated",
                  "estimated",
                  "unknown"
                ]
              },
              {
                "type": "null"
              }
            ]
          },
          "priceCatalogVersion": {
            "type": [
              "string",
              "null"
            ]
          },
          "note": {
            "type": [
              "string",
              "null"
            ]
          }
        },
        "required": [
          "id",
          "createdAt",
          "scope",
          "runId",
          "stepKey",
          "attemptId",
          "type",
          "bucket",
          "deltaMicrousd",
          "certainty",
          "priceCatalogVersion",
          "note"
        ]
      }
    },
    "nextCursor": {
      "type": [
        "string",
        "null"
      ]
    }
  },
  "required": [
    "items",
    "nextCursor"
  ]
}
```

## `ledger.export`

Channel `relay/v1/ledger.export` · command · route `main+runner`

### Input

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "anyOf": [
    {
      "type": "object",
      "properties": {
        "runId": {
          "type": "string",
          "pattern": "^run_[0-7][0-9A-HJKMNP-TV-Z]{25}$"
        }
      },
      "required": [
        "runId"
      ]
    },
    {
      "type": "object",
      "properties": {
        "projectId": {
          "type": "string",
          "pattern": "^prj_[0-7][0-9A-HJKMNP-TV-Z]{25}$"
        },
        "month": {
          "type": "string",
          "pattern": "^\\d{4}-(0[1-9]|1[0-2])$"
        }
      },
      "required": [
        "projectId",
        "month"
      ]
    }
  ]
}
```

### Output

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "exported": {
      "type": "boolean"
    },
    "displayPath": {
      "type": "string"
    }
  },
  "required": [
    "exported"
  ]
}
```
