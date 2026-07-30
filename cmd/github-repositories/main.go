package main

import (
	"context"
	"encoding/json"
	"os"

	"github.com/oiekjr/alfred-workflows/internal/githubrepos"
)

// main は GitHubリポジトリをAlfred Script Filter形式で出力する。
func main() {
	if len(os.Args) == 2 && os.Args[1] == "--login" {
		if err := githubrepos.NewExecRunner().Login(context.Background()); err != nil {
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
		output = []byte(`{"items":[{"title":"Unable to load repositories","subtitle":"The workflow could not create a response.","valid":false}]}`)
	}

	_, _ = os.Stdout.Write(output)
}
