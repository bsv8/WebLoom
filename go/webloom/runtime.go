// Package webloom 提供受信内部插件的 Go 运行时，不承担产品授权或进程隔离。
package webloom

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"sync"
)

// Capability 是两种语言共同使用的能力身份，函数和业务数据不进入描述。
type Capability struct {
	Kind    string `json:"kind"`    // local：进程内服务；rpc：可调用业务能力。
	ID      string `json:"id"`      // 稳定能力名。
	Version string `json:"version"` // 精确契约版本。
}

// Dependency 声明本单元需要的能力，不是外部权限授权。
type Dependency struct {
	Capability Capability `json:"capability"`         // 精确依赖身份。
	Optional   bool       `json:"optional,omitempty"` // 缺失时是否允许继续启动。
}

// Manifest 描述一个 Go 单元；同一插件可另有独立的 Web 单元。
type Manifest struct {
	PluginID     string       `json:"pluginId"`               // 业务插件名。
	UnitID       string       `json:"unitId"`                 // 本进程运行单元名。
	Provides     []Capability `json:"provides,omitempty"`     // 提供的能力。
	Dependencies []Dependency `json:"dependencies,omitempty"` // 消费的能力。
}

// Handler 只接收调用上下文和产品请求；外部输入校验由产品边界负责。
type Handler func(context.Context, any) (any, error)

// Plugin 的函数仅留在本进程；Setup 按依赖顺序调用。
type Plugin struct {
	Manifest Manifest             // 静态描述。
	Setup    func(*Context) error // 依赖就绪后执行的启动函数。
}

var (
	ErrStopped     = errors.New("webloom: instance stopped")
	ErrUnavailable = errors.New("webloom: capability unavailable")
)

type service struct {
	owner    *instance
	handler  Handler
	value    any
	provided bool
}
type instance struct {
	manifest Manifest
	id       string
	ctx      context.Context
	cancel   context.CancelFunc
	cleanups []func(context.Context) error
}

// Runtime 拥有所有 Go 单元；关闭时先停止接单并取消调用，再反向清理。
type Runtime struct {
	mu        sync.Mutex
	id        string
	services  map[Capability]*service
	instances []*instance
	active    bool
	calls     sync.WaitGroup
	closeOnce sync.Once
	done      chan struct{}
	closeErr  error
}

// Context 是框架创建的内部插件上下文，不接受请求自报的插件身份。
type Context struct {
	runtime  *Runtime
	instance *instance
}

func newID() string {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		panic(err)
	}
	return hex.EncodeToString(b[:])
}
func valid(c Capability) bool {
	return c.ID != "" && c.Version != "" && (c.Kind == "local" || c.Kind == "rpc")
}

// Start 在执行任何 Setup 前检查重复能力、缺失依赖和循环依赖。
// 任一 Setup 失败会清理已经启动的单元，不返回半就绪 Runtime。
func Start(parent context.Context, plugins []Plugin) (*Runtime, error) {
	if parent == nil {
		return nil, errors.New("webloom: nil context")
	}
	r := &Runtime{id: newID(), services: make(map[Capability]*service), done: make(chan struct{})}
	units := map[string]bool{}
	owners := map[Capability]int{}
	ps := append([]Plugin(nil), plugins...)
	for i, p := range ps {
		m := p.Manifest
		if m.PluginID == "" || m.UnitID == "" || p.Setup == nil || units[m.UnitID] {
			return nil, fmt.Errorf("webloom: invalid or duplicate unit %q", m.UnitID)
		}
		units[m.UnitID] = true
		ps[i].Manifest.Provides = append([]Capability(nil), m.Provides...)
		ps[i].Manifest.Dependencies = append([]Dependency(nil), m.Dependencies...)
		for _, c := range m.Provides {
			if !valid(c) {
				return nil, fmt.Errorf("webloom: invalid capability %+v", c)
			}
			if _, ok := owners[c]; ok {
				return nil, fmt.Errorf("webloom: duplicate provider %s", c.ID)
			}
			owners[c] = i
		}
	}
	var order []int
	marks := make([]int, len(ps))
	var visit func(int) error
	visit = func(i int) error {
		if marks[i] == 2 {
			return nil
		}
		if marks[i] == 1 {
			return fmt.Errorf("webloom: dependency cycle at %s", ps[i].Manifest.UnitID)
		}
		marks[i] = 1
		for _, d := range ps[i].Manifest.Dependencies {
			if !valid(d.Capability) {
				return errors.New("webloom: invalid dependency")
			}
			j, ok := owners[d.Capability]
			if !ok {
				if d.Optional {
					continue
				}
				return fmt.Errorf("webloom: missing dependency %s", d.Capability.ID)
			}
			if j != i {
				if err := visit(j); err != nil {
					return err
				}
			}
		}
		marks[i] = 2
		order = append(order, i)
		return nil
	}
	for i := range ps {
		if err := visit(i); err != nil {
			return nil, err
		}
	}
	for _, i := range order {
		if err := parent.Err(); err != nil {
			_ = r.Close(context.Background())
			return nil, err
		}
		p := ps[i]
		ctx, cancel := context.WithCancel(parent)
		ins := &instance{manifest: p.Manifest, id: newID(), ctx: ctx, cancel: cancel}
		r.instances = append(r.instances, ins)
		for _, c := range p.Manifest.Provides {
			r.services[c] = &service{owner: ins}
		}
		err := p.Setup(&Context{runtime: r, instance: ins})
		if err == nil {
			for _, c := range p.Manifest.Provides {
				if !r.services[c].provided {
					err = fmt.Errorf("declared capability %s was not provided", c.ID)
					break
				}
			}
		}
		if err != nil {
			cleanup := r.Close(context.Background())
			return nil, errors.Join(fmt.Errorf("webloom: setup %s: %w", p.Manifest.UnitID, err), cleanup)
		}
	}
	if err := parent.Err(); err != nil {
		_ = r.Close(context.Background())
		return nil, err
	}
	r.active = true
	go func() {
		select {
		case <-parent.Done():
			_ = r.Close(context.Background())
		case <-r.done:
		}
	}()
	return r, nil
}

func (c *Context) PluginID() string         { return c.instance.manifest.PluginID }
func (c *Context) UnitID() string           { return c.instance.manifest.UnitID }
func (c *Context) InstanceID() string       { return c.instance.id }
func (c *Context) Context() context.Context { return c.instance.ctx }

// OnDispose 注册资源清理；仅在 Setup 阶段调用，清理按注册逆序运行。
func (c *Context) OnDispose(fn func(context.Context) error) {
	c.instance.cleanups = append(c.instance.cleanups, fn)
}

func (c *Context) provide(cap Capability, value any, handler Handler) error {
	s := c.runtime.services[cap]
	if s == nil || s.owner != c.instance || s.provided {
		return fmt.Errorf("webloom: undeclared or duplicate provide %s", cap.ID)
	}
	s.value = value
	s.handler = handler
	s.provided = true
	return nil
}

// Provide 注册进程内服务；服务对象不跨网络，也不包装为安全沙箱。
func (c *Context) Provide(cap Capability, value any) error {
	if cap.Kind != "local" {
		return errors.New("webloom: Provide requires local capability")
	}
	return c.provide(cap, value, nil)
}
func (c *Context) Handle(cap Capability, handler Handler) error {
	if cap.Kind != "rpc" || handler == nil {
		return errors.New("webloom: Handle requires rpc handler")
	}
	return c.provide(cap, nil, handler)
}
func (c *Context) declared(cap Capability) bool {
	for _, d := range c.instance.manifest.Dependencies {
		if d.Capability == cap {
			return true
		}
	}
	for _, p := range c.instance.manifest.Provides {
		if p == cap {
			return true
		}
	}
	return false
}

// Service 在装配阶段获取普通进程内依赖，不做每次方法调用的身份验证。
func (c *Context) Service(cap Capability) (any, error) {
	if cap.Kind != "local" || !c.declared(cap) {
		return nil, fmt.Errorf("webloom: undeclared local dependency %s", cap.ID)
	}
	s := c.runtime.services[cap]
	if s == nil || !s.provided {
		return nil, ErrUnavailable
	}
	return s.value, nil
}

// RPC 捕获本轮消费者实例。旧运行时关闭后，缓存的调用函数也拒绝新调用。
func (c *Context) RPC(cap Capability) (Handler, error) {
	if cap.Kind != "rpc" || !c.declared(cap) {
		return nil, fmt.Errorf("webloom: undeclared rpc dependency %s", cap.ID)
	}
	if c.runtime.services[cap] == nil {
		return nil, ErrUnavailable
	}
	return func(ctx context.Context, req any) (any, error) {
		if c.instance.ctx.Err() != nil {
			return nil, ErrStopped
		}
		return c.runtime.Call(ctx, cap, req)
	}, nil
}

// Call 供可信产品适配层调用；不是网络入口，产品必须显式映射公开方法。
func (r *Runtime) Call(ctx context.Context, cap Capability, request any) (any, error) {
	if ctx == nil {
		return nil, errors.New("webloom: nil call context")
	}
	r.mu.Lock()
	s := r.services[cap]
	if !r.active {
		r.mu.Unlock()
		return nil, ErrStopped
	}
	if s == nil || s.handler == nil {
		r.mu.Unlock()
		return nil, ErrUnavailable
	}
	if s.owner.ctx.Err() != nil {
		r.mu.Unlock()
		return nil, ErrStopped
	}
	r.calls.Add(1)
	r.mu.Unlock()
	defer r.calls.Done()
	call, cancel := context.WithCancel(ctx)
	defer cancel()
	stop := context.AfterFunc(s.owner.ctx, cancel)
	defer stop()
	if err := call.Err(); err != nil {
		return nil, err
	}
	result, err := s.handler(call, request)
	// 取消不撤销已经完成的业务副作用；这里只阻止交付迟到结果。
	if call.Err() != nil {
		return nil, call.Err()
	}
	if s.owner.ctx.Err() != nil {
		return nil, ErrStopped
	}
	return result, err
}

// Close 可重复调用。超时只结束等待，不在仍有执行时销毁资源。
// 后台继续等待在途调用退出并清理；调用者可再次 Close 等待真实完成。
func (r *Runtime) Close(ctx context.Context) error {
	r.closeOnce.Do(func() {
		r.mu.Lock()
		r.active = false
		for _, ins := range r.instances {
			ins.cancel()
		}
		r.mu.Unlock()
		go func() {
			r.calls.Wait()
			for i := len(r.instances) - 1; i >= 0; i-- {
				ins := r.instances[i]
				for j := len(ins.cleanups) - 1; j >= 0; j-- {
					r.closeErr = errors.Join(r.closeErr, ins.cleanups[j](context.Background()))
				}
			}
			close(r.done)
		}()
	})
	select {
	case <-r.done:
		return r.closeErr
	case <-ctx.Done():
		return ctx.Err()
	}
}

// Snapshot 是诊断数据，不返回服务、存储对象或秘密。
type Snapshot struct {
	RuntimeInstanceID string         `json:"runtimeInstanceId"`
	Active            bool           `json:"active"`
	Units             []UnitSnapshot `json:"units"`
}
type UnitSnapshot struct {
	PluginID   string `json:"pluginId"`
	UnitID     string `json:"unitId"`
	InstanceID string `json:"instanceId"`
}

func (r *Runtime) Snapshot() Snapshot {
	r.mu.Lock()
	defer r.mu.Unlock()
	s := Snapshot{RuntimeInstanceID: r.id, Active: r.active, Units: []UnitSnapshot{}}
	for _, i := range r.instances {
		s.Units = append(s.Units, UnitSnapshot{i.manifest.PluginID, i.manifest.UnitID, i.id})
	}
	return s
}
