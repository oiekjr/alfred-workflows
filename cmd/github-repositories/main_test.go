package main

import "testing"

// TestRequestedAuthenticationActionRequiresTerminalArgumentShape は検索入力から認証操作へ到達できないことを検証する。
func TestRequestedAuthenticationActionRequiresTerminalArgumentShape(t *testing.T) {
	testCases := []struct {
		name       string
		arguments  []string
		wantAction string
		want       bool
	}{
		{
			name:       "Terminal helper invocation",
			arguments:  []string{"github-repositories", "--authentication-helper", "login-projects"},
			wantAction: "login-projects",
			want:       true,
		},
		{
			name:      "Alfred query is one argument",
			arguments: []string{"github-repositories", "--authentication-helper login-projects"},
			want:      false,
		},
		{
			name:      "legacy single flag",
			arguments: []string{"github-repositories", "--login-projects"},
			want:      false,
		},
		{
			name:      "missing action",
			arguments: []string{"github-repositories", "--authentication-helper"},
			want:      false,
		},
	}

	for _, testCase := range testCases {
		t.Run(testCase.name, func(t *testing.T) {
			action, got := requestedAuthenticationAction(testCase.arguments)

			if got != testCase.want || action != testCase.wantAction {
				t.Fatalf(
					"requestedAuthenticationAction() = %q, %t; want %q, %t",
					action,
					got,
					testCase.wantAction,
					testCase.want,
				)
			}
		})
	}
}
