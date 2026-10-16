// These investigation probes assert observed behavior, including defects.
// Run through scripts/probe-cantelop-reconciliation.mjs; update after platform fixes.
package dispatcher

import (
	"context"
	"fmt"
	"testing"
	"time"

	"github.com/stepandel/cantelop/fire-fuse/controlclient"
	"github.com/stepandel/cantelop/fire-fuse/messageprotocol"
	"github.com/stepandel/cantelop/fire-fuse/runtime/session"
)

func TestLatencyProbeAdmissionHintLostWhileWorkerBusy(t *testing.T) {
	d, _, _, e := executionFixture(t)
	d.reconcileWake = make(chan struct{}, 1)
	d.completionWake = make(chan struct{}, 1)
	d.interval = time.Hour
	w := newReconciliationWorkers()
	w.onAvailable = func() { d.wakeReadyCompletions(w) }
	blocked, started := make(chan struct{}), make(chan struct{})
	d.startReconciliation(w, e.SandboxID, func() { close(started); <-blocked })
	<-started
	d.wakeReconciliation()
	if !d.waitForReconciliation(context.Background()) {
		t.Fatal("wake missing")
	}
	if d.startReconciliation(w, e.SandboxID, func() { t.Error("overlap") }) {
		t.Fatal("overlap admitted")
	}
	close(blocked)
	w.wg.Wait()
	if len(d.reconcileWake) != 0 || len(d.completionWake) != 0 {
		t.Fatal("behavior changed: admission rerun was retained")
	}
	t.Log("Admission wake consumed while same-Sandbox worker is running: no rerun survives release; periodic sweep required")
}

type latencyProbeControl struct {
	*executionTestControl
	reads, writes int
}

func (c *latencyProbeControl) GetMessageDelivery(ctx context.Context, id string) (controlclient.MessageDelivery, error) {
	c.reads++
	return controlclient.MessageDelivery{ID: id, WorkspaceID: "workspace", LogicalSessionID: "thread", ReplyRequested: true, Reply: []byte(`{"ok":true}`)}, nil
}
func (c *latencyProbeControl) SaveExecution(ctx context.Context, e controlclient.MessageExecution) (controlclient.MessageExecution, error) {
	c.writes++
	return c.executionTestControl.SaveExecution(ctx, e)
}

type latencyProbeMailbox struct {
	*executionTestMailbox
	statuses, inspections int
}

func (m *latencyProbeMailbox) Status(ctx context.Context, route session.Route, id string) (messageprotocol.Receipt, error) {
	m.statuses++
	receipt := m.receipt
	receipt.MessageID = id
	return receipt, nil
}
func (m *latencyProbeMailbox) Inspect(ctx context.Context, route session.Route) (messageprotocol.RuntimeStatus, error) {
	m.inspections++
	return m.executionTestMailbox.Inspect(ctx, route)
}
func TestLatencyProbeSettledCommandsRevisited(t *testing.T) {
	for _, count := range []int{1, 10, 50, 100} {
		t.Run(fmt.Sprint(count), func(t *testing.T) {
			d, base, mailbox, e := executionFixture(t)
			c := &latencyProbeControl{executionTestControl: base}
			m := &latencyProbeMailbox{executionTestMailbox: mailbox}
			m.receipt.State = "succeeded"
			d.control, d.mailbox = c, m
			group := make([]controlclient.MessageExecution, count)
			for i := range group {
				current := e
				current.MessageID = fmt.Sprintf("msg_%032x", i+1)
				current.Phase = "settled"
				receipt := m.receipt
				receipt.MessageID = current.MessageID
				current.Receipt = &receipt
				group[i] = current
				d.renewed[executionLease(current)] = d.now()
			}
			if err := d.reconcile(context.Background(), group); err != nil {
				t.Fatal(err)
			}
			if c.reads != count || c.writes != count*3 || m.statuses != count || m.inspections != 2 {
				t.Fatalf("unexpected calls: reads=%d writes=%d status=%d inspections=%d", c.reads, c.writes, m.statuses, m.inspections)
			}
			t.Logf("%d already-settled commands, one pass: %d message reads + %d execution saves + %d runtime status calls + %d runtime inspections", count, c.reads, c.writes, m.statuses, m.inspections)
		})
	}
}
