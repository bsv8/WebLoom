// notes 演示同一个插件的 Go 后台。stdin/stdout 只是示例传输，不是正式网络协议。
package main

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"

	"github.com/bsv8/WebLoom/go/webloom"
)

var read = webloom.Capability{Kind: "rpc", ID: "notes.read", Version: "1"}
var save = webloom.Capability{Kind: "rpc", ID: "notes.save", Version: "1"}

func main() {
	if len(os.Args) != 2 {
		panic("需要指定示例数据目录")
	}
	// 宿主按插件归属绑定目录；插件不取得全局根的通用接口。
	path := filepath.Join(os.Args[1], "notes", "note.txt")
	runtime, err := webloom.Start(context.Background(), []webloom.Plugin{{
		Manifest: webloom.Manifest{PluginID: "notes", UnitID: "notes.daemon", Provides: []webloom.Capability{read, save}},
		Setup: func(ctx *webloom.Context) error {
			if err := ctx.Handle(read, func(call context.Context, _ any) (any, error) {
				if err := call.Err(); err != nil {
					return nil, err
				}
				b, err := os.ReadFile(path)
				if os.IsNotExist(err) {
					return "", nil
				}
				return string(b), err
			}); err != nil {
				return err
			}
			return ctx.Handle(save, func(call context.Context, request any) (any, error) {
				if err := call.Err(); err != nil {
					return nil, err
				}
				content, ok := request.(string)
				if !ok {
					return nil, fmt.Errorf("内容必须是字符串")
				}
				if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
					return nil, err
				}
				// 同目录临时文件 + rename，演示完整替换，不在原文件上截断后写。
				tmp, err := os.CreateTemp(filepath.Dir(path), ".note-*")
				if err != nil {
					return nil, err
				}
				defer os.Remove(tmp.Name())
				if _, err = tmp.WriteString(content); err != nil {
					tmp.Close()
					return nil, err
				}
				if err = tmp.Sync(); err != nil {
					tmp.Close()
					return nil, err
				}
				if err = tmp.Close(); err != nil {
					return nil, err
				}
				if err = os.Rename(tmp.Name(), path); err != nil {
					return nil, err
				}
				return true, nil
			})
		},
	}})
	if err != nil {
		panic(err)
	}
	defer runtime.Close(context.Background())
	scanner := bufio.NewScanner(os.Stdin)
	scanner.Buffer(make([]byte, 4096), 1024*1024)
	encoder := json.NewEncoder(os.Stdout)
	for scanner.Scan() {
		var req struct {
			Method  string          `json:"method"`
			Request json.RawMessage `json:"request"`
		}
		var result any
		var callErr error
		if err := json.Unmarshal(scanner.Bytes(), &req); err != nil {
			callErr = err
		} else {
			switch req.Method {
			case "notes.read":
				result, callErr = runtime.Call(context.Background(), read, nil)
			case "notes.save":
				var text string
				if err := json.Unmarshal(req.Request, &text); err != nil {
					callErr = err
				} else {
					result, callErr = runtime.Call(context.Background(), save, text)
				}
			default:
				callErr = fmt.Errorf("未知方法")
			}
		}
		if callErr != nil {
			encoder.Encode(map[string]any{"error": callErr.Error()})
		} else {
			encoder.Encode(map[string]any{"result": result})
		}
	}
	if err := scanner.Err(); err != nil {
		panic(err)
	}
}
