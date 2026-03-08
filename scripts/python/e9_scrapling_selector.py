#!/usr/bin/env python3

import json
import sys

from scrapling import Selector


def extract_field(document, field_input):
    for selector_input in field_input["selectors"]:
        matches = document.css(selector_input["selector"])
        if not matches:
            continue
        node = matches[0]
        raw_value = str(node.text).strip()
        if raw_value != "":
            return {
                "field": field_input["field"],
                "matchedPath": selector_input["path"],
                "rawValue": raw_value,
            }

    return {
        "field": field_input["field"],
    }


def main():
    payload = json.loads(sys.stdin.read())
    cases = payload["cases"]
    results = []

    for case_input in cases:
        document = Selector(case_input["html"])
        fields = [extract_field(document, field_input) for field_input in case_input["fields"]]
        results.append(
            {
                "caseId": case_input["caseId"],
                "fields": fields,
            }
        )

    print(
        json.dumps(
            {
                "runtime": {
                    "scraplingVersion": "0.4.1",
                    "parserAvailable": True,
                    "fetcherAvailable": False,
                    "fetcherDiagnostic": "Fetcher runtime requires undeclared optional dependencies in this benchmark environment.",
                },
                "results": results,
            }
        )
    )


if __name__ == "__main__":
    main()
