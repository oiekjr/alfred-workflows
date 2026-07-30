package main

import (
	"context"
	"encoding/json"
	"os"

	"github.com/oiekjr/alfred-workflows/internal/githubrepos"
)

// main は GitHub上の候補をAlfred Script Filter形式で出力する。
func main() {
	authenticationAction, authenticationRequested := requestedAuthenticationAction(os.Args)
	if authenticationRequested {
		runner := githubrepos.NewExecRunner()
		var authenticationError error

		switch authenticationAction {
		case "login":
			authenticationError = runner.Login(context.Background())
		case "login-projects":
			authenticationError = runner.LoginProjects(context.Background())
		case "authorize-projects":
			authenticationError = runner.AuthorizeProjects(context.Background())
		default:
			_, _ = os.Stderr.WriteString("Unsupported authentication action.\n")
			os.Exit(2)
		}
		if authenticationError != nil {
			_, _ = os.Stderr.WriteString("Unable to start GitHub CLI authentication.\n")
			os.Exit(1)
		}

		return
	}

	app := githubrepos.NewApp(githubrepos.NewExecRunner())
	query := ""
	if len(os.Args) > 1 {
		query = os.Args[1]
	}
	feed := app.Run(context.Background(), query)

	output, err := json.Marshal(feed)
	if err != nil {
		output = []byte(`{"items":[{"title":"Unable to load GitHub results","subtitle":"The workflow could not create a response.","valid":false}]}`)
	}

	_, _ = os.Stdout.Write(output)
}

// requestedAuthenticationAction はTerminal専用の2引数形式だけを認証操作として受け付ける。
func requestedAuthenticationAction(arguments []string) (string, bool) {
	if len(arguments) != 3 || arguments[1] != "--authentication-helper" {
		return "", false
	}

	return arguments[2], true
}
