(function (global, factory) {
    typeof exports === 'object' && typeof module !== 'undefined' ? module.exports = factory() :
    typeof define === 'function' && define.amd ? define(factory) :
    (global = typeof globalThis !== 'undefined' ? globalThis : global || self, global.BankCard = factory());
})(this, (function () { 'use strict';

    function noop() { }
    function run(fn) {
        return fn();
    }
    function blank_object() {
        return Object.create(null);
    }
    function run_all(fns) {
        fns.forEach(run);
    }
    function is_function(thing) {
        return typeof thing === 'function';
    }
    function safe_not_equal(a, b) {
        return a != a ? b == b : a !== b || ((a && typeof a === 'object') || typeof a === 'function');
    }
    function is_empty(obj) {
        return Object.keys(obj).length === 0;
    }
    function subscribe(store, ...callbacks) {
        if (store == null) {
            return noop;
        }
        const unsub = store.subscribe(...callbacks);
        return unsub.unsubscribe ? () => unsub.unsubscribe() : unsub;
    }
    function component_subscribe(component, store, callback) {
        component.$$.on_destroy.push(subscribe(store, callback));
    }
    function action_destroyer(action_result) {
        return action_result && is_function(action_result.destroy) ? action_result.destroy : noop;
    }

    const is_client = typeof window !== 'undefined';
    let now = is_client
        ? () => window.performance.now()
        : () => Date.now();
    let raf = is_client ? cb => requestAnimationFrame(cb) : noop;

    const tasks = new Set();
    function run_tasks(now) {
        tasks.forEach(task => {
            if (!task.c(now)) {
                tasks.delete(task);
                task.f();
            }
        });
        if (tasks.size !== 0)
            raf(run_tasks);
    }
    /**
     * Creates a new task that runs on each raf frame
     * until it returns a falsy value or is aborted
     */
    function loop(callback) {
        let task;
        if (tasks.size === 0)
            raf(run_tasks);
        return {
            promise: new Promise(fulfill => {
                tasks.add(task = { c: callback, f: fulfill });
            }),
            abort() {
                tasks.delete(task);
            }
        };
    }
    function append(target, node) {
        target.appendChild(node);
    }
    function insert(target, node, anchor) {
        target.insertBefore(node, anchor || null);
    }
    function detach(node) {
        if (node.parentNode) {
            node.parentNode.removeChild(node);
        }
    }
    function element(name) {
        return document.createElement(name);
    }
    function svg_element(name) {
        return document.createElementNS('http://www.w3.org/2000/svg', name);
    }
    function text(data) {
        return document.createTextNode(data);
    }
    function space() {
        return text(' ');
    }
    function listen(node, event, handler, options) {
        node.addEventListener(event, handler, options);
        return () => node.removeEventListener(event, handler, options);
    }
    function attr(node, attribute, value) {
        if (value == null)
            node.removeAttribute(attribute);
        else if (node.getAttribute(attribute) !== value)
            node.setAttribute(attribute, value);
    }
    function children(element) {
        return Array.from(element.childNodes);
    }
    function attribute_to_object(attributes) {
        const result = {};
        for (const attribute of attributes) {
            result[attribute.name] = attribute.value;
        }
        return result;
    }

    let current_component;
    function set_current_component(component) {
        current_component = component;
    }
    function get_current_component() {
        if (!current_component)
            throw new Error('Function called outside component initialization');
        return current_component;
    }
    /**
     * The `onMount` function schedules a callback to run as soon as the component has been mounted to the DOM.
     * It must be called during the component's initialisation (but doesn't need to live *inside* the component;
     * it can be called from an external module).
     *
     * `onMount` does not run inside a [server-side component](/docs#run-time-server-side-component-api).
     *
     * https://svelte.dev/docs#run-time-svelte-onmount
     */
    function onMount(fn) {
        get_current_component().$$.on_mount.push(fn);
    }

    const dirty_components = [];
    const binding_callbacks = [];
    let render_callbacks = [];
    const flush_callbacks = [];
    const resolved_promise = /* @__PURE__ */ Promise.resolve();
    let update_scheduled = false;
    function schedule_update() {
        if (!update_scheduled) {
            update_scheduled = true;
            resolved_promise.then(flush);
        }
    }
    function add_render_callback(fn) {
        render_callbacks.push(fn);
    }
    // flush() calls callbacks in this order:
    // 1. All beforeUpdate callbacks, in order: parents before children
    // 2. All bind:this callbacks, in reverse order: children before parents.
    // 3. All afterUpdate callbacks, in order: parents before children. EXCEPT
    //    for afterUpdates called during the initial onMount, which are called in
    //    reverse order: children before parents.
    // Since callbacks might update component values, which could trigger another
    // call to flush(), the following steps guard against this:
    // 1. During beforeUpdate, any updated components will be added to the
    //    dirty_components array and will cause a reentrant call to flush(). Because
    //    the flush index is kept outside the function, the reentrant call will pick
    //    up where the earlier call left off and go through all dirty components. The
    //    current_component value is saved and restored so that the reentrant call will
    //    not interfere with the "parent" flush() call.
    // 2. bind:this callbacks cannot trigger new flush() calls.
    // 3. During afterUpdate, any updated components will NOT have their afterUpdate
    //    callback called a second time; the seen_callbacks set, outside the flush()
    //    function, guarantees this behavior.
    const seen_callbacks = new Set();
    let flushidx = 0; // Do *not* move this inside the flush() function
    function flush() {
        // Do not reenter flush while dirty components are updated, as this can
        // result in an infinite loop. Instead, let the inner flush handle it.
        // Reentrancy is ok afterwards for bindings etc.
        if (flushidx !== 0) {
            return;
        }
        const saved_component = current_component;
        do {
            // first, call beforeUpdate functions
            // and update components
            try {
                while (flushidx < dirty_components.length) {
                    const component = dirty_components[flushidx];
                    flushidx++;
                    set_current_component(component);
                    update(component.$$);
                }
            }
            catch (e) {
                // reset dirty state to not end up in a deadlocked state and then rethrow
                dirty_components.length = 0;
                flushidx = 0;
                throw e;
            }
            set_current_component(null);
            dirty_components.length = 0;
            flushidx = 0;
            while (binding_callbacks.length)
                binding_callbacks.pop()();
            // then, once components are updated, call
            // afterUpdate functions. This may cause
            // subsequent updates...
            for (let i = 0; i < render_callbacks.length; i += 1) {
                const callback = render_callbacks[i];
                if (!seen_callbacks.has(callback)) {
                    // ...so guard against infinite loops
                    seen_callbacks.add(callback);
                    callback();
                }
            }
            render_callbacks.length = 0;
        } while (dirty_components.length);
        while (flush_callbacks.length) {
            flush_callbacks.pop()();
        }
        update_scheduled = false;
        seen_callbacks.clear();
        set_current_component(saved_component);
    }
    function update($$) {
        if ($$.fragment !== null) {
            $$.update();
            run_all($$.before_update);
            const dirty = $$.dirty;
            $$.dirty = [-1];
            $$.fragment && $$.fragment.p($$.ctx, dirty);
            $$.after_update.forEach(add_render_callback);
        }
    }
    /**
     * Useful for example to execute remaining `afterUpdate` callbacks before executing `destroy`.
     */
    function flush_render_callbacks(fns) {
        const filtered = [];
        const targets = [];
        render_callbacks.forEach((c) => fns.indexOf(c) === -1 ? filtered.push(c) : targets.push(c));
        targets.forEach((c) => c());
        render_callbacks = filtered;
    }
    const outroing = new Set();
    function transition_in(block, local) {
        if (block && block.i) {
            outroing.delete(block);
            block.i(local);
        }
    }
    function mount_component(component, target, anchor, customElement) {
        const { fragment, after_update } = component.$$;
        fragment && fragment.m(target, anchor);
        if (!customElement) {
            // onMount happens before the initial afterUpdate
            add_render_callback(() => {
                const new_on_destroy = component.$$.on_mount.map(run).filter(is_function);
                // if the component was destroyed immediately
                // it will update the `$$.on_destroy` reference to `null`.
                // the destructured on_destroy may still reference to the old array
                if (component.$$.on_destroy) {
                    component.$$.on_destroy.push(...new_on_destroy);
                }
                else {
                    // Edge case - component was destroyed immediately,
                    // most likely as a result of a binding initialising
                    run_all(new_on_destroy);
                }
                component.$$.on_mount = [];
            });
        }
        after_update.forEach(add_render_callback);
    }
    function destroy_component(component, detaching) {
        const $$ = component.$$;
        if ($$.fragment !== null) {
            flush_render_callbacks($$.after_update);
            run_all($$.on_destroy);
            $$.fragment && $$.fragment.d(detaching);
            // TODO null out other refs, including component.$$ (but need to
            // preserve final state?)
            $$.on_destroy = $$.fragment = null;
            $$.ctx = [];
        }
    }
    function make_dirty(component, i) {
        if (component.$$.dirty[0] === -1) {
            dirty_components.push(component);
            schedule_update();
            component.$$.dirty.fill(0);
        }
        component.$$.dirty[(i / 31) | 0] |= (1 << (i % 31));
    }
    function init(component, options, instance, create_fragment, not_equal, props, append_styles, dirty = [-1]) {
        const parent_component = current_component;
        set_current_component(component);
        const $$ = component.$$ = {
            fragment: null,
            ctx: [],
            // state
            props,
            update: noop,
            not_equal,
            bound: blank_object(),
            // lifecycle
            on_mount: [],
            on_destroy: [],
            on_disconnect: [],
            before_update: [],
            after_update: [],
            context: new Map(options.context || (parent_component ? parent_component.$$.context : [])),
            // everything else
            callbacks: blank_object(),
            dirty,
            skip_bound: false,
            root: options.target || parent_component.$$.root
        };
        append_styles && append_styles($$.root);
        let ready = false;
        $$.ctx = instance
            ? instance(component, options.props || {}, (i, ret, ...rest) => {
                const value = rest.length ? rest[0] : ret;
                if ($$.ctx && not_equal($$.ctx[i], $$.ctx[i] = value)) {
                    if (!$$.skip_bound && $$.bound[i])
                        $$.bound[i](value);
                    if (ready)
                        make_dirty(component, i);
                }
                return ret;
            })
            : [];
        $$.update();
        ready = true;
        run_all($$.before_update);
        // `false` as a special case of no DOM component
        $$.fragment = create_fragment ? create_fragment($$.ctx) : false;
        if (options.target) {
            if (options.hydrate) {
                const nodes = children(options.target);
                // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
                $$.fragment && $$.fragment.l(nodes);
                nodes.forEach(detach);
            }
            else {
                // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
                $$.fragment && $$.fragment.c();
            }
            if (options.intro)
                transition_in(component.$$.fragment);
            mount_component(component, options.target, options.anchor, options.customElement);
            flush();
        }
        set_current_component(parent_component);
    }
    let SvelteElement;
    if (typeof HTMLElement === 'function') {
        SvelteElement = class extends HTMLElement {
            constructor() {
                super();
                this.attachShadow({ mode: 'open' });
            }
            connectedCallback() {
                const { on_mount } = this.$$;
                this.$$.on_disconnect = on_mount.map(run).filter(is_function);
                // @ts-ignore todo: improve typings
                for (const key in this.$$.slotted) {
                    // @ts-ignore todo: improve typings
                    this.appendChild(this.$$.slotted[key]);
                }
            }
            attributeChangedCallback(attr, _oldValue, newValue) {
                this[attr] = newValue;
            }
            disconnectedCallback() {
                run_all(this.$$.on_disconnect);
            }
            $destroy() {
                destroy_component(this, 1);
                this.$destroy = noop;
            }
            $on(type, callback) {
                // TODO should this delegate to addEventListener?
                if (!is_function(callback)) {
                    return noop;
                }
                const callbacks = (this.$$.callbacks[type] || (this.$$.callbacks[type] = []));
                callbacks.push(callback);
                return () => {
                    const index = callbacks.indexOf(callback);
                    if (index !== -1)
                        callbacks.splice(index, 1);
                };
            }
            $set($$props) {
                if (this.$$set && !is_empty($$props)) {
                    this.$$.skip_bound = true;
                    this.$$set($$props);
                    this.$$.skip_bound = false;
                }
            }
        };
    }

    const subscriber_queue = [];
    /**
     * Create a `Writable` store that allows both updating and reading by subscription.
     * @param {*=}value initial value
     * @param {StartStopNotifier=} start
     */
    function writable(value, start = noop) {
        let stop;
        const subscribers = new Set();
        function set(new_value) {
            if (safe_not_equal(value, new_value)) {
                value = new_value;
                if (stop) { // store is ready
                    const run_queue = !subscriber_queue.length;
                    for (const subscriber of subscribers) {
                        subscriber[1]();
                        subscriber_queue.push(subscriber, value);
                    }
                    if (run_queue) {
                        for (let i = 0; i < subscriber_queue.length; i += 2) {
                            subscriber_queue[i][0](subscriber_queue[i + 1]);
                        }
                        subscriber_queue.length = 0;
                    }
                }
            }
        }
        function update(fn) {
            set(fn(value));
        }
        function subscribe(run, invalidate = noop) {
            const subscriber = [run, invalidate];
            subscribers.add(subscriber);
            if (subscribers.size === 1) {
                stop = start(set) || noop;
            }
            run(value);
            return () => {
                subscribers.delete(subscriber);
                if (subscribers.size === 0 && stop) {
                    stop();
                    stop = null;
                }
            };
        }
        return { set, update, subscribe };
    }

    function is_date(obj) {
        return Object.prototype.toString.call(obj) === '[object Date]';
    }

    function tick_spring(ctx, last_value, current_value, target_value) {
        if (typeof current_value === 'number' || is_date(current_value)) {
            // @ts-ignore
            const delta = target_value - current_value;
            // @ts-ignore
            const velocity = (current_value - last_value) / (ctx.dt || 1 / 60); // guard div by 0
            const spring = ctx.opts.stiffness * delta;
            const damper = ctx.opts.damping * velocity;
            const acceleration = (spring - damper) * ctx.inv_mass;
            const d = (velocity + acceleration) * ctx.dt;
            if (Math.abs(d) < ctx.opts.precision && Math.abs(delta) < ctx.opts.precision) {
                return target_value; // settled
            }
            else {
                ctx.settled = false; // signal loop to keep ticking
                // @ts-ignore
                return is_date(current_value) ?
                    new Date(current_value.getTime() + d) : current_value + d;
            }
        }
        else if (Array.isArray(current_value)) {
            // @ts-ignore
            return current_value.map((_, i) => tick_spring(ctx, last_value[i], current_value[i], target_value[i]));
        }
        else if (typeof current_value === 'object') {
            const next_value = {};
            for (const k in current_value) {
                // @ts-ignore
                next_value[k] = tick_spring(ctx, last_value[k], current_value[k], target_value[k]);
            }
            // @ts-ignore
            return next_value;
        }
        else {
            throw new Error(`Cannot spring ${typeof current_value} values`);
        }
    }
    function spring(value, opts = {}) {
        const store = writable(value);
        const { stiffness = 0.15, damping = 0.8, precision = 0.01 } = opts;
        let last_time;
        let task;
        let current_token;
        let last_value = value;
        let target_value = value;
        let inv_mass = 1;
        let inv_mass_recovery_rate = 0;
        let cancel_task = false;
        function set(new_value, opts = {}) {
            target_value = new_value;
            const token = current_token = {};
            if (value == null || opts.hard || (spring.stiffness >= 1 && spring.damping >= 1)) {
                cancel_task = true; // cancel any running animation
                last_time = now();
                last_value = new_value;
                store.set(value = target_value);
                return Promise.resolve();
            }
            else if (opts.soft) {
                const rate = opts.soft === true ? .5 : +opts.soft;
                inv_mass_recovery_rate = 1 / (rate * 60);
                inv_mass = 0; // infinite mass, unaffected by spring forces
            }
            if (!task) {
                last_time = now();
                cancel_task = false;
                task = loop(now => {
                    if (cancel_task) {
                        cancel_task = false;
                        task = null;
                        return false;
                    }
                    inv_mass = Math.min(inv_mass + inv_mass_recovery_rate, 1);
                    const ctx = {
                        inv_mass,
                        opts: spring,
                        settled: true,
                        dt: (now - last_time) * 60 / 1000
                    };
                    const next_value = tick_spring(ctx, last_value, value, target_value);
                    last_time = now;
                    last_value = value;
                    store.set(value = next_value);
                    if (ctx.settled) {
                        task = null;
                    }
                    return !ctx.settled;
                });
            }
            return new Promise(fulfil => {
                task.promise.then(() => {
                    if (token === current_token)
                        fulfil();
                });
            });
        }
        const spring = {
            set,
            update: (fn, opts) => set(fn(target_value, value), opts),
            subscribe: store.subscribe,
            stiffness,
            damping,
            precision
        };
        return spring;
    }

    /* src/Card.svelte generated by Svelte v3.59.1 */

    function create_fragment(ctx) {
    	let div10;
    	let button;
    	let t14;
    	let svg4;
    	let g0;
    	let polyline0;
    	let polyline1;
    	let polyline2;
    	let polyline3;
    	let polyline4;
    	let polyline5;
    	let polyline6;
    	let polyline7;
    	let polyline8;
    	let t15;
    	let svg5;
    	let g1;
    	let path0;
    	let path1;
    	let path2;
    	let t16;
    	let svg6;
    	let g2;
    	let path3;
    	let path4;
    	let path5;
    	let path6;
    	let path7;
    	let path8;
    	let path9;
    	let path10;
    	let path11;
    	let path12;
    	let t17;
    	let svg7;
    	let g3;
    	let path13;
    	let path14;
    	let path15;
    	let path16;
    	let path17;
    	let path18;
    	let path19;
    	let path20;
    	let path21;
    	let path22;
    	let path23;
    	let path24;
    	let path25;
    	let path26;
    	let path27;
    	let path28;
    	let path29;
    	let path30;
    	let path31;
    	let path32;
    	let path33;
    	let path34;
    	let path35;
    	let path36;
    	let path37;
    	let path38;
    	let path39;
    	let path40;
    	let path41;
    	let path42;
    	let path43;
    	let path44;
    	let path45;
    	let path46;
    	let path47;
    	let path48;
    	let path49;
    	let path50;
    	let path51;
    	let path52;
    	let path53;
    	let path54;
    	let path55;
    	let path56;
    	let path57;
    	let path58;
    	let path59;
    	let path60;
    	let path61;
    	let path62;
    	let path63;
    	let path64;
    	let path65;
    	let path66;
    	let path67;
    	let path68;
    	let path69;
    	let path70;
    	let path71;
    	let path72;
    	let path73;
    	let path74;
    	let path75;
    	let path76;
    	let path77;
    	let path78;
    	let path79;
    	let path80;
    	let path81;
    	let path82;
    	let path83;
    	let path84;
    	let path85;
    	let path86;
    	let path87;
    	let path88;
    	let path89;
    	let path90;
    	let path91;
    	let path92;
    	let path93;
    	let path94;
    	let path95;
    	let path96;
    	let path97;
    	let path98;
    	let path99;
    	let path100;
    	let path101;
    	let path102;
    	let path103;
    	let path104;
    	let path105;
    	let path106;
    	let path107;
    	let path108;
    	let path109;
    	let path110;
    	let path111;
    	let path112;
    	let path113;
    	let path114;
    	let path115;
    	let path116;
    	let path117;
    	let path118;
    	let path119;
    	let path120;
    	let path121;
    	let path122;
    	let path123;
    	let path124;
    	let path125;
    	let path126;
    	let path127;
    	let path128;
    	let path129;
    	let path130;
    	let path131;
    	let path132;
    	let path133;
    	let path134;
    	let path135;
    	let path136;
    	let path137;
    	let path138;
    	let path139;
    	let path140;
    	let path141;
    	let path142;
    	let path143;
    	let path144;
    	let path145;
    	let path146;
    	let path147;
    	let path148;
    	let path149;
    	let path150;
    	let path151;
    	let path152;
    	let path153;
    	let path154;
    	let path155;
    	let path156;
    	let path157;
    	let path158;
    	let path159;
    	let path160;
    	let path161;
    	let path162;
    	let path163;
    	let path164;
    	let path165;
    	let path166;
    	let path167;
    	let path168;
    	let path169;
    	let path170;
    	let path171;
    	let path172;
    	let path173;
    	let path174;
    	let path175;
    	let path176;
    	let path177;
    	let path178;
    	let path179;
    	let path180;
    	let path181;
    	let path182;
    	let path183;
    	let path184;
    	let path185;
    	let path186;
    	let path187;
    	let path188;
    	let path189;
    	let path190;
    	let path191;
    	let path192;
    	let path193;
    	let path194;
    	let path195;
    	let mounted;
    	let dispose;

    	return {
    		c() {
    			div10 = element("div");
    			button = element("button");

    			button.innerHTML = `<div class="bank-card__border"></div> 
    <div class="bank-card__rfid"></div> 
    <div class="bank-card__chip"><svg role="img" viewBox="0 0 100 100" aria-label="Chip"><use href="#chip-lines"></use></svg></div> 
    <div class="bank-card__contactless"><svg role="img" viewBox="0 0 24 24" aria-label="Contactless"><use href="#contactless-logo"></use></svg></div> 
    <label class="bank-card__number" for="bank-card">5388 1337 8455 9047</label> 
    <img class="bank-card__master" src="https://simey-credit-card.netlify.app/img/logos/master.svg" alt="master card logo"/> 
    <h2 class="bank-card__logo">CREDIT CARD</h2> 
    <div class="bank-card__shine"></div> 
    <div class="bank-card__logo-outline"><svg role="img" viewBox="0 0 1026.98 128.75" aria-label="Logo"><use href="#bank-paths"></use></svg></div> 
    <div class="bank-card__world"><svg role="img" viewBox="0 0 145.87 67.56" aria-label="Hologram"><use href="#world-paths"></use></svg></div> 
    <div class="bank-card__glare"></div> 
    <div class="bank-card__texture"></div> 
    <div class="bank-card__border-bottom"></div>`;

    			t14 = space();
    			svg4 = svg_element("svg");
    			g0 = svg_element("g");
    			polyline0 = svg_element("polyline");
    			polyline1 = svg_element("polyline");
    			polyline2 = svg_element("polyline");
    			polyline3 = svg_element("polyline");
    			polyline4 = svg_element("polyline");
    			polyline5 = svg_element("polyline");
    			polyline6 = svg_element("polyline");
    			polyline7 = svg_element("polyline");
    			polyline8 = svg_element("polyline");
    			t15 = space();
    			svg5 = svg_element("svg");
    			g1 = svg_element("g");
    			path0 = svg_element("path");
    			path1 = svg_element("path");
    			path2 = svg_element("path");
    			t16 = space();
    			svg6 = svg_element("svg");
    			g2 = svg_element("g");
    			path3 = svg_element("path");
    			path4 = svg_element("path");
    			path5 = svg_element("path");
    			path6 = svg_element("path");
    			path7 = svg_element("path");
    			path8 = svg_element("path");
    			path9 = svg_element("path");
    			path10 = svg_element("path");
    			path11 = svg_element("path");
    			path12 = svg_element("path");
    			t17 = space();
    			svg7 = svg_element("svg");
    			g3 = svg_element("g");
    			path13 = svg_element("path");
    			path14 = svg_element("path");
    			path15 = svg_element("path");
    			path16 = svg_element("path");
    			path17 = svg_element("path");
    			path18 = svg_element("path");
    			path19 = svg_element("path");
    			path20 = svg_element("path");
    			path21 = svg_element("path");
    			path22 = svg_element("path");
    			path23 = svg_element("path");
    			path24 = svg_element("path");
    			path25 = svg_element("path");
    			path26 = svg_element("path");
    			path27 = svg_element("path");
    			path28 = svg_element("path");
    			path29 = svg_element("path");
    			path30 = svg_element("path");
    			path31 = svg_element("path");
    			path32 = svg_element("path");
    			path33 = svg_element("path");
    			path34 = svg_element("path");
    			path35 = svg_element("path");
    			path36 = svg_element("path");
    			path37 = svg_element("path");
    			path38 = svg_element("path");
    			path39 = svg_element("path");
    			path40 = svg_element("path");
    			path41 = svg_element("path");
    			path42 = svg_element("path");
    			path43 = svg_element("path");
    			path44 = svg_element("path");
    			path45 = svg_element("path");
    			path46 = svg_element("path");
    			path47 = svg_element("path");
    			path48 = svg_element("path");
    			path49 = svg_element("path");
    			path50 = svg_element("path");
    			path51 = svg_element("path");
    			path52 = svg_element("path");
    			path53 = svg_element("path");
    			path54 = svg_element("path");
    			path55 = svg_element("path");
    			path56 = svg_element("path");
    			path57 = svg_element("path");
    			path58 = svg_element("path");
    			path59 = svg_element("path");
    			path60 = svg_element("path");
    			path61 = svg_element("path");
    			path62 = svg_element("path");
    			path63 = svg_element("path");
    			path64 = svg_element("path");
    			path65 = svg_element("path");
    			path66 = svg_element("path");
    			path67 = svg_element("path");
    			path68 = svg_element("path");
    			path69 = svg_element("path");
    			path70 = svg_element("path");
    			path71 = svg_element("path");
    			path72 = svg_element("path");
    			path73 = svg_element("path");
    			path74 = svg_element("path");
    			path75 = svg_element("path");
    			path76 = svg_element("path");
    			path77 = svg_element("path");
    			path78 = svg_element("path");
    			path79 = svg_element("path");
    			path80 = svg_element("path");
    			path81 = svg_element("path");
    			path82 = svg_element("path");
    			path83 = svg_element("path");
    			path84 = svg_element("path");
    			path85 = svg_element("path");
    			path86 = svg_element("path");
    			path87 = svg_element("path");
    			path88 = svg_element("path");
    			path89 = svg_element("path");
    			path90 = svg_element("path");
    			path91 = svg_element("path");
    			path92 = svg_element("path");
    			path93 = svg_element("path");
    			path94 = svg_element("path");
    			path95 = svg_element("path");
    			path96 = svg_element("path");
    			path97 = svg_element("path");
    			path98 = svg_element("path");
    			path99 = svg_element("path");
    			path100 = svg_element("path");
    			path101 = svg_element("path");
    			path102 = svg_element("path");
    			path103 = svg_element("path");
    			path104 = svg_element("path");
    			path105 = svg_element("path");
    			path106 = svg_element("path");
    			path107 = svg_element("path");
    			path108 = svg_element("path");
    			path109 = svg_element("path");
    			path110 = svg_element("path");
    			path111 = svg_element("path");
    			path112 = svg_element("path");
    			path113 = svg_element("path");
    			path114 = svg_element("path");
    			path115 = svg_element("path");
    			path116 = svg_element("path");
    			path117 = svg_element("path");
    			path118 = svg_element("path");
    			path119 = svg_element("path");
    			path120 = svg_element("path");
    			path121 = svg_element("path");
    			path122 = svg_element("path");
    			path123 = svg_element("path");
    			path124 = svg_element("path");
    			path125 = svg_element("path");
    			path126 = svg_element("path");
    			path127 = svg_element("path");
    			path128 = svg_element("path");
    			path129 = svg_element("path");
    			path130 = svg_element("path");
    			path131 = svg_element("path");
    			path132 = svg_element("path");
    			path133 = svg_element("path");
    			path134 = svg_element("path");
    			path135 = svg_element("path");
    			path136 = svg_element("path");
    			path137 = svg_element("path");
    			path138 = svg_element("path");
    			path139 = svg_element("path");
    			path140 = svg_element("path");
    			path141 = svg_element("path");
    			path142 = svg_element("path");
    			path143 = svg_element("path");
    			path144 = svg_element("path");
    			path145 = svg_element("path");
    			path146 = svg_element("path");
    			path147 = svg_element("path");
    			path148 = svg_element("path");
    			path149 = svg_element("path");
    			path150 = svg_element("path");
    			path151 = svg_element("path");
    			path152 = svg_element("path");
    			path153 = svg_element("path");
    			path154 = svg_element("path");
    			path155 = svg_element("path");
    			path156 = svg_element("path");
    			path157 = svg_element("path");
    			path158 = svg_element("path");
    			path159 = svg_element("path");
    			path160 = svg_element("path");
    			path161 = svg_element("path");
    			path162 = svg_element("path");
    			path163 = svg_element("path");
    			path164 = svg_element("path");
    			path165 = svg_element("path");
    			path166 = svg_element("path");
    			path167 = svg_element("path");
    			path168 = svg_element("path");
    			path169 = svg_element("path");
    			path170 = svg_element("path");
    			path171 = svg_element("path");
    			path172 = svg_element("path");
    			path173 = svg_element("path");
    			path174 = svg_element("path");
    			path175 = svg_element("path");
    			path176 = svg_element("path");
    			path177 = svg_element("path");
    			path178 = svg_element("path");
    			path179 = svg_element("path");
    			path180 = svg_element("path");
    			path181 = svg_element("path");
    			path182 = svg_element("path");
    			path183 = svg_element("path");
    			path184 = svg_element("path");
    			path185 = svg_element("path");
    			path186 = svg_element("path");
    			path187 = svg_element("path");
    			path188 = svg_element("path");
    			path189 = svg_element("path");
    			path190 = svg_element("path");
    			path191 = svg_element("path");
    			path192 = svg_element("path");
    			path193 = svg_element("path");
    			path194 = svg_element("path");
    			path195 = svg_element("path");
    			this.c = noop;
    			attr(button, "class", "bank-rotator");
    			attr(polyline0, "points", "0,50 35,50");
    			attr(polyline1, "points", "0,20 20,20 35,35");
    			attr(polyline2, "points", "50,0 50,35");
    			attr(polyline3, "points", "65,35 80,20 100,20");
    			attr(polyline4, "points", "100,50 65,50");
    			attr(polyline5, "points", "35,35 65,35 65,65 35,65 35,35");
    			attr(polyline6, "points", "0,80 20,80 35,65");
    			attr(polyline7, "points", "50,100 50,65");
    			attr(polyline8, "points", "65,65 80,80 100,80");
    			attr(g0, "id", "chip-lines");
    			attr(svg4, "id", "chip");
    			attr(path0, "d", "M9.172 15.172a4 4 0 0 1 5.656 0");
    			attr(path1, "d", "M6.343 12.343a8 8 0 0 1 11.314 0");
    			attr(path2, "d", "M3.515 9.515c4.686 -4.687 12.284 -4.687 17 0");
    			attr(g1, "id", "contactless-logo");
    			attr(svg5, "id", "contactless");
    			attr(path3, "d", "m94.5,123.2c-9.78,3.7-21.06,5.56-33.86,5.56s-23.43-2.53-32.54-7.6c-9.12-5.06-16.08-12.27-20.89-21.62C2.4,90.19,0,79.41,0,67.2c0-13.14,2.69-24.83,8.07-35.08,5.38-10.25,12.99-18.16,22.82-23.75C40.73,2.79,52.04,0,64.84,0c10.22,0,20.1,1.3,29.66,3.91v34.64c-3.3-2.08-7.22-3.7-11.78-4.86-4.56-1.16-9.17-1.74-13.84-1.74-9.67,0-17.29,2.92-22.86,8.77-5.58,5.85-8.36,13.78-8.36,23.79s2.79,17.81,8.36,23.57c5.57,5.76,13.03,8.64,22.37,8.64,8.62,0,17.33-2.31,26.12-6.95v33.43Z");
    			attr(path4, "d", "m164.72,126.58l-8.82-26.83c-1.7-5.27-3.91-9.41-6.63-12.42s-5.67-4.51-8.86-4.51h-1.4v43.76h-35.59V2.08h47.29c16.53,0,28.74,2.85,36.62,8.55,7.88,5.7,11.82,14.25,11.82,25.66,0,8.57-2.29,15.74-6.88,21.53-4.59,5.79-11.41,9.98-20.47,12.59v.35c5,1.62,9.16,4.25,12.48,7.9,3.32,3.65,6.3,9.06,8.94,16.24l11.62,31.69h-40.12Zm-3.38-85c0-4.17-1.21-7.47-3.62-9.9-2.42-2.43-6.21-3.65-11.37-3.65h-7.33v28.48h6.43c4.78,0,8.62-1.42,11.53-4.25,2.91-2.83,4.37-6.39,4.37-10.68Z");
    			attr(path5, "d", "m209.07,126.58V2.08h73.57v29.35h-37.98v18.14h35.67v29.35h-35.67v18.32h40.7v29.34h-76.29Z");
    			attr(path6, "d", "m404.11,62.77c0,12.62-2.51,23.78-7.54,33.47-5.03,9.7-12.21,17.18-21.54,22.44-9.34,5.27-20.1,7.9-32.3,7.9h-50.01V2.08h48.94c41.63,0,62.45,20.23,62.45,60.69Zm-37.82.35c0-6.08-1.17-11.55-3.5-16.41-2.34-4.86-5.67-8.62-10.01-11.29-4.34-2.66-9.45-3.99-15.32-3.99h-9.15v65.81h9.97c8.51,0,15.31-3.08,20.39-9.25,5.08-6.16,7.62-14.46,7.62-24.87Z");
    			attr(path7, "d", "m411.3,126.58V2.08h35.59v124.5h-35.59Z");
    			attr(path8, "d", "m520.41,31.43v95.15h-35.76V31.43h-33.04V2.08h102.24v29.35h-33.45Z");
    			attr(path9, "d", "m683.92,123.2c-9.78,3.7-21.06,5.56-33.86,5.56s-23.43-2.53-32.54-7.6c-9.12-5.06-16.08-12.27-20.89-21.62-4.81-9.35-7.21-20.13-7.21-32.34,0-13.14,2.69-24.83,8.07-35.08,5.38-10.25,12.99-18.16,22.82-23.75,9.83-5.58,21.15-8.38,33.94-8.38,10.22,0,20.1,1.3,29.66,3.91v34.64c-3.3-2.08-7.22-3.7-11.78-4.86-4.56-1.16-9.17-1.74-13.84-1.74-9.67,0-17.29,2.92-22.86,8.77-5.58,5.85-8.36,13.78-8.36,23.79s2.79,17.81,8.36,23.57c5.57,5.76,13.03,8.64,22.37,8.64,8.62,0,17.33-2.31,26.12-6.95v33.43Z");
    			attr(path10, "d", "m766.91,126.58l-5.19-22.92h-35.26l-5.6,22.92h-38.48L723.08,2.08h44.16l38.31,124.5h-38.64Zm-22.41-97.41h-.82c-.11,1.39-.49,3.68-1.15,6.86-.66,3.18-3.98,16.84-9.97,40.98h22.57l-8.24-33.86c-1.15-4.98-1.95-9.64-2.39-13.98Z");
    			attr(path11, "d", "m871.24,126.58l-8.82-26.83c-1.7-5.27-3.91-9.41-6.63-12.42s-5.67-4.51-8.86-4.51h-1.4v43.76h-35.59V2.08h47.29c16.53,0,28.74,2.85,36.62,8.55,7.88,5.7,11.82,14.25,11.82,25.66,0,8.57-2.29,15.74-6.88,21.53-4.59,5.79-11.41,9.98-20.47,12.59v.35c5,1.62,9.16,4.25,12.48,7.9,3.32,3.65,6.3,9.06,8.94,16.24l11.62,31.69h-40.12Zm-3.38-85c0-4.17-1.21-7.47-3.62-9.9-2.42-2.43-6.21-3.65-11.37-3.65h-7.33v28.48h6.43c4.78,0,8.62-1.42,11.53-4.25,2.91-2.83,4.37-6.39,4.37-10.68Z");
    			attr(path12, "d", "m1026.98,62.77c0,12.62-2.51,23.78-7.54,33.47-5.03,9.7-12.21,17.18-21.54,22.44-9.34,5.27-20.1,7.9-32.3,7.9h-50.01V2.08h48.94c41.63,0,62.45,20.23,62.45,60.69Zm-37.82.35c0-6.08-1.17-11.55-3.5-16.41-2.34-4.86-5.67-8.62-10.01-11.29-4.34-2.66-9.45-3.99-15.32-3.99h-9.15v65.81h9.97c8.51,0,15.31-3.08,20.39-9.25,5.08-6.16,7.62-14.46,7.62-24.87Z");
    			attr(g2, "id", "bank-paths");
    			attr(svg6, "id", "bank-text");
    			attr(svg6, "viewBox", "0 0 1026.98 128.75");
    			attr(path13, "d", "m16.24,7.14s-1.04-.18-1.24-.3c-.2-.12-.99-.06-1.24-.18-.25-.12-.45-.06-.79,0-.35.06-.94,0-1.19-.06-.25-.06-.3-.24-1.04-.18-.74.06-1.04-.06-.99-.12.05-.06.3-.18-.25-.18s-.84.12-.99.12.15-.18.1-.18-.45-.12-.69,0c-.25.12-.89.18-.89.18,0,0-.65.24-.94.24s-.55.3-.6.49c-.05.18-.84.18-1.04.18s-.05.18-.15.24c-.1.06.89.3.94.48.05.18.15.24.69.24,0,0-.05.18.2.18s.54.06.54.06c0,0-.79.3-1.29.18-.5-.12,0-.18,0-.18,0,0-.45-.12-1.74.36,0,0,.2.12.5.18,0,0,.25,0,.1.06-.15.06-.2.24,0,.3.2.06.65.18.89.06.25-.12.4.18.55.12.15-.06.5-.3.65-.24.15.06-.1.18-.1.18,0,0,.4.3.05.36-.35.06-.4,0-.55.12-.15.12-.35.24-.4.12-.05-.12-.3-.24-.5.18,0,0-.54.48-.54.54s.15.24.45.24c0,0,.05.18-.1.24,0,0,.35.18.5.42,0,0,.55.06.65-.24,0,0,.3.24.25.36-.05.12-.1.12-.05.18.05.06-.1.18-.1.18,0,0,.25.12.69-.12,0,0,.2.12.35.06,0,0,.25.3.35.24.1-.06-.05-.18,0-.24.05-.06.15.12.5.06.35-.06,0,.06-.05.3-.05.24-.35.36-.45.48-.1.12-.55.18-.74.55,0,0-.4-.06-.79.24-.4.3-.25.18-.35.18s-.4,0-.55.12c-.15.12.1.24.1.24,0,0,0-.06.3-.12.3-.06.2-.06.4-.12.2-.06.3.06.4-.12.1-.18.15-.24.2-.18.05.06.05.12.3,0,.25-.12.4-.24.4-.12s.4-.18.54-.24c.15-.06-.1-.12-.1-.12,0,0,.2,0,.35-.06.15-.06-.05-.12-.05-.12,0,0,.35.06.5-.06.15-.12.2-.24.3-.3.1-.06.25-.24.45-.24s.25-.3.45-.3.15-.18.05-.18-.35.06-.3-.06c.05-.12.3-.24.4-.24s.35-.18.4-.3c.05-.12.4-.42.5-.42s.4.06.4.06c0,0-.45,0-.5.12-.05.12-.1.24-.2.3-.1.06-.25.3-.15.3s.35-.06.35-.06c0,0-.25.18-.35.18s-.05.18.25.12c.3-.06.6-.42.74-.42s.6-.06.6,0,0,.12.15.06.2-.24.25-.24-.15,0-.2.06c-.05.06.05-.12.05-.12h-.2s.1-.24.35-.18c.25.06.05.24.35.18s.25.18.4.18.35-.06.5.06c.15.12.35-.12.5-.06.15.06.79.24.89.24s.3-.3.35-.24c.05.06-.15.24-.1.3.05.06.35.06.5.18.15.12.45.42.65.42s.1-.06.1.06.4.48.55.67c.15.18.3.42.3.24s-.2-.91-.2-.91l-.35-.06-.2-.24.2.12.3.06-.1-.42.2.3.15.73s.25-.06.25-.12-.1-.42-.1-.42c0,0,.3.3.25.49-.05.18-.1,0-.25.18-.15.18-.05.36-.05.48s.15-.06.15-.18.2-.18.25-.12c.05.06-.2.12-.2.3s.15.49.3.55c.15.06.35.06.4-.06.05-.12-.3-.61-.3-.61,0,0,.5.42.55.55.05.12.3.06.35.18.05.12-.2.24-.1.42.1.18.6.42.74.67.15.24.35.36.45.54.1.18.45.18.45.18,0,0,.1.18-.15.12-.25-.06-.35-.24-.5-.18-.15.06-.05.24.4.55.45.3.99.55,1.04.61.05.06.45.18.5,0,.05-.18-.59-.55-.64-.61-.05-.06,0-.12.1-.06.1.06.89.48.84.54-.05.06-.2.12-.15.18.05.06,0,.18-.05.18s-.15-.06-.4-.06-.3.06-.15.3c.15.24.25.67.2,1.03-.05.36-.05.49-.05.67s-.2.36-.2.55.2.48.2.61,0,.36-.05.42c-.05.06-.1.24.05.42q.15.18.15.42c0,.24.25.3.3.42.05.12.15.24.2.18.05-.06.15.12.15.12,0,0-.15-.06-.15.06s.15.3.2.3.15.12.05.12-.1,0,0,.12c.1.12.45.48.45.54v.36c0,.06.4,0,.4,0,0,0,.25.18.3.24.05.06.25,0,.25,0,0,0,.1.12.2.18.1.06.25.18.25.24s0,.42.1.55c.1.12.15.24.2.3.05.06,0,.12.05.18.05.06.1.18.1.3s.05.3.25.36c.2.06.55.36.55.48s0,.55-.3.36c-.3-.18.1.18.15.24.05.06.15.24.3.24s.2-.06.2-.06l.05.12c.05.12.2.24.3.24s.1.12.1.24-.15.24-.1.36c.05.12.1.3.25.3s.35.12.35.18v.12s.1,0,.15.06c.05.06.1.06.1.18s.05.18.15.12c.1-.06.3-.12.2-.3-.1-.18-.2-.24-.2-.36s-.2.12-.25,0c-.05-.12-.05-.18-.05-.36s-.15,0-.2-.24c-.05-.24-.05-.48-.3-.79-.25-.3-.35-.18-.35-.36s-.2-.48-.3-.61c-.1-.12-.45-.48-.45-.48,0,0,.1-.12.05-.24-.05-.12-.15-.3-.1-.36.05-.06-.15-.3-.15-.3,0,0,.35.36.4.3.05-.06.15-.12.2,0,.05.12.25.06.25.12v.3c0,.12.1.06.1.12s-.05.18.05.3c.1.12.1.18.1.24s-.15,0-.1.12c.05.12.2.18.2.06s.3.36.3.36c0,0,0,.12.3.06,0,0-.05.24,0,.3.05.06.2.12.3.12,0,0-.05.12.05.18.1.06.15,0,.15.06s.05.18-.05.3c-.1.12,0,.24.2.24s.1,0,.2.12c.1.12.05,0,.15.06.1.06-.05.18.05.3.1.12.2,0,.25.06.05.06.3.42.4.61.1.18.25.18.25.18,0,0-.05.18,0,.3.05.12.3.3.25.42-.05.12-.3.06-.2.18s-.05.06-.05.12,0,.3.1.36c.1.06.25.3.25.3,0,0,.35.06.4.24.05.18.3.42.79.36,0,0,.2.49,1.09.67,0,0,.2,0,.3.12.1.12.4.18.55.3.15.12.54-.12.65-.18.1-.06.5-.12.84.36.35.48.59.79.94.73.35-.06.35.3.89.3s.54-.12.54-.12c0,0-.25.18-.2.24.05.06.1.24.35.36.25.12-.1.18.4.49,0,0-.05.18,0,.24.05.06-.1.24.05.36.15.12.15.24.25.18.1-.06.15-.3.2-.18.05.12-.05.24.15.3.2.06.25.3.2.36-.05.06-.1.18.2.18s.4-.06.5.06c.1.12.3.18.35.3.05.12.15.12.3.06.15-.06.25-.12.1-.24-.15-.12-.15-.24-.05-.24s.25-.06.25-.18.05-.18.15-.12c.1.06.3.12.3.24s-.05.3.05.42c.1.12.35.3.35.42s-.05.36,0,.42c.05.06-.1,0-.05.12.05.12.1.36.05.48-.05.12-.1.3,0,.36.1.06-.2.55-.25.55s-.25,0-.25.12-.1.18-.15.3c-.05.12.05.3.05.3l-.45.18s0,.3-.05.36c-.05.06-.2.12-.2.3s0,0-.05.24c-.05.24.1.36,0,.48-.1.12,0,.18.05.24.05.06.35.12.35.12,0,0-.1.18-.4.42-.3.24-.15.61-.15.61,0,0,0,.18.05.3.05.12-.15,0-.1.12.05.12.45.3.5.42.05.12.35.61.5.85.15.24.05.55.15.73.1.18.3.3.3.49s.1.24.15.36c.05.12.45.48.45.67s0,.36-.1.36.2.61.45.73.69.48.74.55c.05.06.1.06.35.18.25.12.45.18.45.3s.45.48.45.48c0,0,.05.55.05.67s.05.73,0,.91c-.05.18-.05.61-.05.67s-.05-.12-.1,0c-.05.12.05.3.05.3,0,0-.05.12-.05.36s0,.48-.05.61c-.05.12.05.49-.05.61-.1.12-.15.79-.2.85-.05.06-.2.06-.1.18.1.12.1.61,0,.61s.05.73.05.85.05.42-.05.49c-.1.06-.05.36-.05.36,0,0-.15.06-.15.18s0,.36-.1.42c-.1.06-.25.61-.25.67s-.1.24-.25.3c-.15.06,0,.18,0,.3s-.05.48.05.61c.1.12.05.48-.05.55-.1.06-.25.36-.15.54.1.18.15.3.1.3s-.1-.12-.15,0c-.05.12.05.36-.05.48s-.2.3-.05.36c.15.06.2-.06.3-.24.1-.18.05-.36.1-.49.05-.12.15-.42.2-.18.05.24-.1.91-.15,1.09-.05.18-.1.48-.1.48,0,0,0-.61-.25-.55-.25.06-.1.42-.15.55-.05.12-.3.67-.4.73-.1.06-.25.3-.05.3s.2-.18.35-.12c.15.06.25.18.15.24-.1.06-.45.18-.45.24s-.15.36-.1.55c.05.18.1.36.1.48s-.2.24-.1.36c.1.12.05.24.15.12.1-.12.3-.3.25-.18-.05.12-.25.36-.25.42s-.05.18.1.36.2.18.35.24c.15.06.4.12.2.18-.2.06-.2,0-.1.18.1.18.3.42.45.42s.15.06.3.18c.15.12.3.3.5.24.2-.06.25-.12.35-.12s-.25.18.05.24c.3.06.5.06.6.06s.1-.12.05-.18c-.05-.06.3.06.4.06s.1-.12.2-.12.4-.06.5-.06.35-.18.15-.18-.94-.18-1.04-.42c-.1-.24-.3-.18-.35-.24-.05-.06.05-.06.05-.18s-.05-.12-.2-.12-.3.12-.25,0c.05-.12.05-.24.25-.18.2.06.3.12.25.06-.05-.06-.35-.3-.35-.55s.25-.61.4-.54c.15.06.25,0,.25-.18s.45-.67.65-.73c.2-.06.2-.61.1-.61s-.64,0-.64-.24.15-.61.54-.73c.4-.12.3-.42.3-.55s.2-.36.3-.36,0-.12-.1-.18c-.1-.06.15-.12.1-.18-.05-.06-.1,0-.15-.12-.05-.12-.15-.73.05-.61.2.12.65.24.79.12.15-.12.15-.3.25-.67.1-.36.35-.36.6-.36s.99,0,1.19-.36c.2-.36.45-.73.4-.85-.05-.12-.15-.12-.2-.18-.05-.06,0-.24,0-.42s.2-.12.35-.12.3.06.45,0c.15-.06.55-.18.89-.73.35-.55.94-1.21,1.04-1.4.1-.18.2-.73.55-.91.35-.18.05-1.15.1-1.27.05-.12.4-.79,1.04-1.09.64-.3,1.24-.55,1.54-.42.3.12-.25-.36.45-.36,0,0-.15-.42.15-.67.3-.24.1-.48.35-.61.25-.12-.15-.61.2-.79,0,0,.05-.79.15-.91.1-.12-.3-1.21,0-1.46.3-.24.2.12.5-.42.3-.55.4-.85.74-1.09.35-.24.4-1.15.3-1.88-.1-.73-.2-.42-.5-.48-.3-.06-.99-.61-1.19-.85-.2-.24-.89-.24-1.04-.24s-.59-.36-.89-.12c-.3.24-.1-.36-.3-.55-.2-.18-.55-.18-.69-.3s-.5-.12-.79.18c0,0,.05-.3.1-.42.05-.12-.3-.06-.45-.06s-.3-.3-.25-.42c.05-.12.2-.36.1-.48-.1-.12-.25-.12-.3-.24-.05-.12-.25-.79-.2-.97.05-.18-.45-.55-.84-.67-.4-.12-1.09-.12-1.34-.18-.25-.06-.99-.97-1.09-1.09-.1-.12-.5-.24-.5-.24,0,0,.1-.06-.05-.24-.15-.18-.2-.18-.35-.3s-.25-.18-.2-.3c.05-.12-.1-.24-.6-.12-.5.12-.35.3-.64.24-.3-.06-.45-.12-.4-.24.05-.12-.55,0-.69.06-.15.06-.05-.06-.15-.24-.1-.18-.4-.24-.5-.24s-.05-.42-.25-.3c-.2.12,0,.36,0,.36,0,0-.3,0-.4.12-.1.12-.35.12-.25-.06.1-.18.35-.18.35-.36s.05-.36-.15-.3c-.2.06-.3.24-.5.36-.2.12-.3.24-.45.24s-.25,0-.3.12c-.05.12-.5,0-.5.67,0,0-.45.36-.45.61s-.4-.24-.5-.36c-.1-.12-.45-.18-.55-.18s-.4.55-.7.42c-.3-.12-.69-.42-.74-.61-.05-.18-.3-.3-.2-.79.1-.48,0-.61.05-.79.05-.18.05-.24.1-.36.05-.12.05-.61-.2-.67-.25-.06-.1-.18-.25-.24-.15-.06-.6-.06-.74,0-.15.06-.4.12-.55.06-.15-.06-.5,0-.5-.06s.05,0,.15-.24c.1-.24.2-.61.2-.79s.15-.06.15-.24-.15-.24,0-.55c.15-.3.25-.36.3-.48.05-.12.1-.24.05-.3-.05-.06-.1-.12-.25-.12s-.65,0-.74.06c-.1.06-.54.06-.54.42s-.05.18-.1.36c-.05.18.05.3-.1.36-.15.06.1.12-.1.18-.2.06-.15.12-.3,0s-.2-.06-.35.06c-.15.12-.15-.06-.35.06-.2.12-.25.18-.3.06-.05-.12-.15-.3-.3-.24-.15.06-.15,0-.25-.18-.1-.18-.4-.61-.5-.73-.1-.12-.25-1.09-.2-1.58.05-.48-.05-.73.1-.73s.1,0,.1-.18-.1-.36-.05-.54c.05-.18.1-.61.3-.67.2-.06.6-.24.65-.36.05-.12.45-.36.64-.3.2.06.35.18.45.12.1-.06.25-.06.35.06.1.12.3.24.4.12.1-.12.4,0,.45,0s-.15-.24-.1-.3c.05-.06.05-.36.35-.3.3.06.59.06.94.06s.2.24.35.3c.15.06.5-.06.5-.18s.25.36.4.36.1.42.05.48c-.05.06.3.67.35.79.05.12.4.36.35.54-.05.18.3.24.35.12.05-.12.25-.79.15-.97-.1-.18-.25-.55-.25-.67s-.59-1.03-.15-1.58c.45-.54.55-.42.65-.54.1-.12.2-.36.5-.42.3-.06.2-.36.64-.36s-.1-.36-.1-.36c0,0,.45,0,.55-.18.1-.18-.15-.3-.2-.42-.05-.12-.2-.18-.2-.3s.1-.12.05-.36c-.05-.24-.15-.36-.1-.48.05-.12.15-.18.15.06s.1.55.1.73,0,0,.15-.24c.15-.24.25-.36.15-.49-.1-.12-.2-.48-.1-.36.1.12.15.55.3.24.15-.3.2-.24.2-.55s.5-.12.79-.3c.3-.18.15-.36.5-.24s.5.06.4-.12c-.1-.18-.2-.12-.3-.3-.1-.18-.25-.36,0-.55.25-.18,1.04-.42,1.29-.61.25-.18.54-.3.84-.36.3-.06-.3.36-.35.42-.05.06-.15.42.15.48.3.06.45-.36.65-.42.2-.06.94-.42,1.14-.42s.25-.24.5-.3c.25-.06-.15-.3-.15-.3,0,0,0-.48-.25-.18-.25.3-.2.48-.25.55-.05.06-.3,0-.45-.06-.15-.06-.84-.18-.89-.42-.05-.24-.15-.18.05-.36.2-.18.2-.24,0-.18-.2.06-.45,0-.45-.06s.5-.06.6-.18c.1-.12.05-.36-.2-.42-.25-.06-1.04,0-1.84.61,0,0,.4-.55.69-.61.3-.06.35-.18.35-.3s.7-.3,1.09-.24c.4.06,1.19.12,1.59.06.4-.06.55-.55.89-.55s.79-.24.89-.36c.1-.12-.05-.24,0-.36.05-.12.25-.36,0-.42-.25-.06-.69-.12-.69-.24s.35-.18-.1-.3c-.45-.12-1.24-.36-1.34-.67-.1-.3-.05-.73-.4-.91s-.69-.97-.94-1.09c-.25-.12-.1-.06-.25.12-.15.18-.55.85-.74.79-.2-.06-.89-.06-.99-.49-.1-.42-.15-.42,0-.54.15-.12.2-.36,0-.3-.2.06-.84.24-.89,0-.05-.24-.35-.61-.65-.61s-.55.18-.94.06c-.4-.12-.6-.12-.74-.12s-.3.42-.15.48c.15.06-.3.36-.3.36,0,0,.55.24.5.42-.05.18-.55.48-.55.48,0,0,.74.36.79.79s-.1,1.03-.99,1.27c0,0-.3-.12-.15.24.15.36.15.73.35.85.2.12.1.18-.05.3-.15.12-.1.36-.3.36s-.3-.06-.35-.24c-.05-.18-.1-.24-.3-.3-.2-.06-.2,0-.25-.24-.05-.24-.1-.3-.05-.42.05-.12,0-.3-.05-.42-.05-.12,0-.36-.05-.36s-1.14,0-1.34-.18c-.2-.18-1.09-.3-1.34-.67-.25-.36-1.34-.06-1.34-.06,0,0-.25-.55-.25-.73s-.45-.06-.55-.12c-.1-.06-.15-.91.15-1.09s.69-.55.84-.67c.15-.12.45-.06.55-.24.1-.18-.15-.3-.15-.3,0,0,.54.12.54-.06s.45,0,.74-.3c.3-.3.4-.36.35-.42-.05-.06-.4.06-.59,0-.2-.06-.35-.12-.4-.24-.05-.12.5.18.79.12.3-.06.45-.18.5-.24.05-.06-.15-.18-.15-.24s.2-.12.35-.06c.15.06.2.18.35.24.15.06.45.3.5.18q.05-.12-.1-.24c-.15-.12.2-.12.5-.24.3-.12.5-.06.5-.24s-.15-.18-.25-.3c-.1-.12-.25-.24-.05-.3.2-.06.45,0,.35-.18-.1-.18,0-.12-.25-.24-.25-.12-.1-.18-.55-.18s-.99-.24-.94,0c.05.24.45.36.2.42-.25.06-.35.18-.4.3-.05.12-.15.06-.15.06,0,0-.25-.24-.3-.12-.05.12-.05.24.2.3.25.06-.15.18-.2.18s-.35,0-.4-.18c-.05-.18,0-.24.05-.24s.1-.18,0-.3c-.1-.12-.35-.36-.5-.24-.15.12-.15.18-.25.18s-.15.12-.15-.06.05-.3-.15-.3-.3.06-.35,0c-.05-.06,0,.06-.15,0-.15-.06,0-.24.1-.24s-.25-.12-.35-.24c-.1-.12-.3-.48-.45-.48s-.25,0-.3-.06c-.05-.06.2-.12.3-.18.1-.06.1,0,.1-.12s.45-.06.55-.12c.1-.06.6-.42.69-.48.1-.06-.05-.18-.4-.18s-1.24-.12-1.49,0c-.25.12-.3.3-.25.48.05.18.3.06.2.24-.1.18,0,.36-.2.42-.2.06-.54-.06-.4.24.15.3-.15.18,0,.42.15.24.5.3.6.3s.5-.06.4.12c-.1.18-.35.18-.2.3.15.12.5-.24.45-.06-.05.18-.25.42-.45.42s-.25-.18-.3,0c-.05.18.15.18,0,.3-.15.12-.3.24-.3,0s-.15-.42-.3-.42-.3-.12.1-.18c.4-.06.6.12.5-.06-.1-.18-.25-.18-.2-.24.05-.06-.1-.18-.25-.18s-.35.12-.45,0c-.1-.12-.3-.24-.35-.06-.05.18.05.42-.2.36-.25-.06-.25.06-.05.12.2.06.59.06.45.12-.15.06-.25.06-.25.18s.1.24-.6.18c-.69-.06-1.19-.24-1.49-.18-.3.06-.35-.06-.3-.12.05-.06-.35-.3-.65-.24-.3.06-.64.18-.79.18s-.2.24-.05.24.2-.18.2.12.15.67-.05.42c-.2-.24-.2-.42-.35-.42s-.1-.18-.4-.12c-.3.06-1.54.24-1.94.12-.4-.12.3-.24.3-.24,0,0-.05-.18-.55-.24-.5-.06-1.04-.06-1.34-.18-.3-.12-.65-.18-.94-.3-.3-.12-.6-.06-.69,0-.1.06-.2.36-.45.24-.25-.12-.1-.12-.15-.3-.05-.18-.3-.18-.35-.06s.3.3,0,.3-.55-.06-.79-.48c-.25-.42-.5,0-.45.06.05.06.05.24-.15.24s-.3,0-.4.06c-.1.06.4-.12.2-.24-.2-.12-1.04.3-1.24.3s-.45.06-.59,0c-.15-.06-.1-.12-.35-.06-.25.06-.5.06-.54.36Z");
    			attr(path14, "d", "m33.9,40.63c0,.06.05.12.1.18.05.06,0,.12-.05.18-.05.06-.15.24.05.18.2-.06.2-.12.25-.18.05-.06-.05-.12.1-.06.15.06.35.12.25,0-.1-.12-.15-.18-.2-.24-.05-.06-.1-.06-.2-.06s-.1,0-.15-.06c-.05-.06-.15-.12-.15.06Z");
    			attr(path15, "d", "m34.74,40.99s.05-.06.15-.06.2,0,.1.06c-.1.06-.15.12-.2.12s-.15-.06-.05-.12Z");
    			attr(path16, "d", "m34.45,41.11s.05.18,0,.18-.2,0-.15-.06c.05-.06.05-.18.15-.12Z");
    			attr(path17, "d", "m36.83,29.65s.5-.42,1.04-.3c.55.12.79.3,1.04.3s.45.12.6.3c.15.18.45.36.65.36s.15.12.1.18c-.05.06.15,0,.3.06.15.06.15.12.25.18.1.06,0,.18-.25.18s-.55-.06-.74,0c-.2.06-.1.12-.25.06-.15-.06-.05-.18.05-.24.1-.06.1-.18,0-.18s-.15.18-.25.12c-.1-.06-.15,0-.2-.18-.05-.18-.05-.24-.15-.18-.1.06.05,0-.2-.12-.25-.12-.5-.12-.55-.24-.05-.12-.2.06-.4-.06-.2-.12-.15-.12-.1-.18.05-.06-.1-.18-.3-.12-.2.06-.2.24-.4.24s-.05.18-.2.18-.4.12-.35,0c.05-.12.3-.36.3-.36Z");
    			attr(path18, "d", "m37.57,30.1c0,.08-.08.15-.17.15s-.17-.07-.17-.15.08-.15.17-.15.17.07.17.15Z");
    			attr(path19, "d", "m39.41,31.59s.54.06.59.24c.05.18,0,.18-.15.18s-.3.06-.4,0c-.1-.06-.15-.12-.25-.18-.1-.06-.05-.24.2-.24Z");
    			attr(path20, "d", "m41.09,30.92s.35-.12.54.06c.2.18.3-.12.45-.06.15.06,1.09.42,1.14.61.05.18-.3.36-.35.24-.05-.12-.2-.12-.35-.06-.15.06-.25.18-.3.06-.05-.12-.25.12-.3.24-.05.12-.15.06-.25-.12-.1-.18-.15-.12-.35-.12h-.45c-.15,0-.3-.3-.2-.3s.15.12.4.12.4.06.35-.06c-.05-.12-.25-.12-.15-.24.1-.12-.05-.18-.15-.24-.1-.06-.05-.12-.05-.12Z");
    			attr(path21, "d", "m44.22,31.77c0,.1-.13.18-.35.18s-.3-.08-.3-.18.08-.18.3-.18.35.08.35.18Z");
    			attr(path22, "d", "m39.11,28.55s.1-.06.1-.12.1-.12.15.06q.05.18.05.3c0,.12.15.06.1.18-.05.12-.2.24-.2.06s-.15-.24-.2-.3c-.05-.06-.05-.18,0-.18Z");
    			attr(path23, "d", "m41.29,30.37s-.07.06-.15.06-.15-.03-.15-.06.07-.06.15-.06.15.03.15.06Z");
    			attr(path24, "d", "m39.01,27.58c.08-.1.1-.12.3-.06.2.06.4.18.4.36s-.1.24-.15.12c-.05-.12,0-.3-.15-.36-.15-.06-.2.06-.3.06s-.15-.06-.1-.12Z");
    			attr(path25, "d", "m45.81,35.53c.1-.12,0-.18.15-.18s.2.12.15.24c-.05.12-.1.12-.15.18-.05.06-.15.12-.15,0s-.05-.18,0-.24Z");
    			attr(path26, "d", "m45.81,32.62c0,.06-.05,0-.1.06-.05.06-.1.18,0,.18s.1,0,.15-.06c.05-.06.1-.3.05-.24-.05.06-.1.06-.1.06Z");
    			attr(path27, "d", "m45.86,33.1c0,.06.1.18.1.06s-.1-.24-.1-.18v.12Z");
    			attr(path28, "d", "m45.96,33.47c0,.06.05.06.1.12.05.06.05-.12.05-.12,0,0,.05-.12-.05-.12s-.1,0-.1.12Z");
    			attr(path29, "d", "m46.01,33.83q-.05.06,0,.12c.05.06.05,0,.1-.06.05-.06.05-.24,0-.18-.05.06-.1.12-.1.12Z");
    			attr(path30, "d", "m45.91,34.19s0,.18.1.06c.1-.12.05-.18,0-.18s-.1.06-.1.12Z");
    			attr(path31, "d", "m45.71,34.68c.05.06.15.12.15.06s0-.18-.05-.18-.15.06-.1.12Z");
    			attr(path32, "d", "m46.55,34.13c0,.06-.05.18,0,.18s.1.06.15,0c.05-.06.05-.12,0-.18-.05-.06-.15,0-.15,0Z");
    			attr(path33, "d", "m44.94,17.97s.25.18.4.12c.15-.06.25-.12.25,0s-.1.12-.1.18-.1.12-.2,0c-.1-.12-.15-.06-.3-.12-.15-.06-.27-.09-.27-.15s0-.24.15-.18c.15.06-.05.06.08.15Z");
    			attr(path34, "d", "m44.72,16.48s.3.06.45.24c.15.18.45.06.55.06s.15-.12-.15-.18c-.3-.06-.25-.18-.4-.18s-.45-.06-.5-.06-.1.06.05.12Z");
    			attr(path35, "d", "m47.62,15.78s.45-.36.6-.3c.15.06-.3.61-.35.73-.05.12-.22.33.07.09.3-.24.15.24.15.24,0,0,.3.06.35,0,.05-.06.2-.18.3-.12.1.06.2.18.25.24.05.06,0,.06,0,.18s.15.12.2.18c.05.06-.2.3-.25.36-.05.06.3-.24.35-.18.05.06-.15.24-.15.3s.15-.18.2-.12c.05.06,0,.42-.15.54-.15.12-.25.18-.25.06s0-.18-.15-.12.05-.18.05-.24-.05-.06-.2,0c-.15.06-.1.12-.25.18-.15.06-.2.12-.3.06-.1-.06.1-.18.2-.24.1-.06.1-.24.05-.18-.05.06-.15.24-.3.12s-.15-.12-.3-.06c-.15.06-.55,0-.79,0s-.45.12-.35-.06c.1-.18.3-.18.35-.3.05-.12-.05-.18-.15-.12-.1.06.1-.24.3-.42.2-.18.2-.3.3-.48.1-.18.22-.33.22-.33Z");
    			attr(path36, "d", "m8.82,12.75s.2-.12.3-.12.05-.06.25-.24c.2-.18.37-.33.47-.21.1.12.3.06.25.18-.05.12-.3.06-.35.12-.05.06.15.12.15.18s0,.06-.15.12c-.15.06-.3.12-.4.18-.1.06.05.18-.05.24-.1.06-.1-.06-.3,0-.2.06-.15-.06-.05-.12.1-.06.05-.12,0-.18-.05-.06-.3-.12-.12-.15Z");
    			attr(path37, "d", "m17.52,14.24s.4.18.55.12c.15-.06-.2.06-.15.3.05.24.25.48.35.55.1.06.05.18.05.24s-.25-.18-.3-.24c-.05-.06-.6-.42-.6-.67s0-.3.1-.3Z");
    			attr(path38, "d", "m20.8,4.47s.6,0,.94-.06c.35-.06.6.06.65.12.05.06.4.18.54.12.15-.06.6-.24.69-.12.1.12.94.36.94.36,0,0-1.34.3-1.44.42-.1.12-.3.3-.4.3s-.25.12-.25.24-.35.12-.45.12-.35.18-.45.18-.4,0-.4-.12-.1-.24-.3-.24-.45-.06-.55-.06.65-.91.74-.91-.3-.18-.3-.36Z");
    			attr(path39, "d", "m23.18,5.44s.99-.36,1.39-.42c.4-.06.55.24.4.3-.15.06.05.12.2,0,.15-.12.2-.24.3-.18.1.06.65.12.69.18.05.06-.2.18-.1.18s.35-.18.4-.18-.15-.12-.15-.12c0,0,.4-.12.6.06.2.18.4.67.65.55.25-.12.1-.12,0-.24-.1-.12-.4-.36-.15-.48.25-.12.4-.06.54,0,.15.06.1-.06-.05-.18-.15-.12.6-.18.69-.12.1.06.25.18,0,.42-.25.24.25.54.25.61s0,.3-.1.3.25.06.4.18c.15.12.15-.06.25,0,.1.06.35.18.6.18s.3.12.25.24c-.05.12.1.24,0,.24s-.25.06-.25-.06-.1-.18-.2-.18-.15.12-.25.12-.2-.06-.25-.06,0,.06.15.12c.15.06.25,0,.35.06.1.06.2.06.2.06,0,0-.2.12-.35.18-.15.06-.4,0-.59,0s-.3,0-.35-.06c-.05-.06-.15-.06-.25-.06s-.15-.06-.25-.06-.15,0-.15-.06-.05-.24-.15-.12c-.1.12-.1.3-.3.3s-.45-.06-.55,0c-.1.06-.1.18-.35.18s-1.14.12-1.34,0c-.2-.12-.3-.12-.25-.18.05-.06-.05-.12-.3-.12s-.79,0-.89-.12c-.1-.12-.15-.06-.2-.12-.05-.06-.05-.18.05-.18s1.44-.18,1.59-.12c.15.06.2,0,.35,0s0-.06-.1-.12c-.1-.06-.74-.12-.99-.06-.25.06-.45.12-.69.06-.25-.06-.65-.12-.65-.18s.2-.06.35-.12c.15-.06.35-.06.45-.06s.1-.18-.3-.12c-.4.06-.55.18-.55.06s-.1,0-.2-.06c-.1-.06-.05-.24.1-.24s.1-.18.05-.18Z");
    			attr(path40, "d", "m37.72,14.78s.45,0,.5.12c.05.12-.05.18-.15.12-.1-.06-.4-.12-.35-.24Z");
    			attr(path41, "d", "m36.18,8.66c0,.14-.1.36-.1.42s-.15.06-.1.24c.05.18,0,.24-.2.24s-.25.12-.15.18c.1.06.4-.12.5-.06.1.06,0,.24.1.3.1.06.45-.12.55-.18.1-.06.2,0,.25-.12.05-.12.15-.24.2-.18.05.06.4.18.5.24.1.06.3.12.4.06.1-.06.25-.12.3-.12s0-.12-.2-.18c-.2-.06-.3.12-.35,0-.05-.12,0-.18-.1-.24-.1-.06-.45-.06-.55-.18-.1-.12-.25-.18-.35-.18s0,.06-.2,0c-.2-.06,0,0-.05-.12-.05-.12-.1-.24-.2-.18-.1.06-.25,0-.25.06Z");
    			attr(path42, "d", "m37.67,10.05s-.55-.12-.65.06c-.1.18-.15.36.05.36s.55-.24.6-.3c.05-.06.05-.12,0-.12Z");
    			attr(path43, "d", "m38.46,10.36s.25-.12.3,0c.05.12-.05.3-.1.36-.05.06-.3,0-.3-.12s.1-.24.1-.24Z");
    			attr(path44, "d", "m39.11,9.75s.4.06.35.18c-.05.12-.15.12-.25,0-.1-.12-.2-.06-.1-.18Z");
    			attr(path45, "d", "m39.61,9.69s.25,0,.25.06,0,.18-.15.12q-.15-.06-.15-.12c0-.06.05-.06.05-.06Z");
    			attr(path46, "d", "m39.51,8.96s-.45.18-.3.3c.15.12.35.18.45.24.1.06.2,0,.3-.06.1-.06.45-.18.5-.12.05.06.4.12.35.06-.05-.06.2,0,.3.06.1.06.3.3.45.3s.15.06.15.12.1.06.25.18c.15.12.25.18.35.18s.2.06.15-.06c-.05-.12.15-.06.25.06.1.12.94.24,1.09.3.15.06.35.06.35,0s-.05-.18-.2-.24c-.15-.06-.5-.24-.6-.3-.1-.06-.1-.18-.25-.24-.15-.06.05-.12.2,0,.15.12.4.18.45.18s0,.18.2.18.3-.06.4.06c.1.12.25.36.35.24.1-.12.15-.12,0-.18-.15-.06-.2-.06-.2-.12s.2-.06.15-.12c-.05-.06,0-.12.1-.12s.25-.06.2-.12c-.05-.06-.15-.24-.25-.24s-.25,0-.25-.06.05-.18-.05-.24c-.1-.06-.3,0-.4-.06-.1-.06-.3-.24-.3-.3s-.1.06-.2,0c-.1-.06-.25-.12-.25-.18s.1-.06.3-.06.05-.12-.05-.18c-.1-.06.1,0,.2,0s.05.06.25.12c.2.06.45.18.5.3.05.12.25.18.4.18s.2.18.25.06c.05-.12.05-.36.1-.36s.3.18.3.06.1-.18.15-.18,0-.18.15-.18.25-.06.2-.12c-.05-.06-.2-.24-.3-.24s-.15.12-.25.06c-.1-.06-.1-.24-.2-.24s-.1.06-.2.06-.05-.06-.1-.12q-.05-.06-.2-.06c-.15,0,0-.06-.15-.12-.15-.06-.3-.06-.4-.06s-.15-.12-.25-.12-.2-.12-.35-.12h-.35c-.1,0-.1-.06.05-.12.15-.06.2-.12.3-.12s.3,0,.3-.06-.1-.12-.25-.12-.4-.06-.25-.12c.15-.06.4,0,.2-.18-.2-.18-.35-.12-.45-.06-.1.06-.2-.12-.1-.12s.35-.18-.05-.18-.6.06-.69,0c-.1-.06,0-.12-.05-.18-.05-.06-.15.18-.3.12-.15-.06.15-.06.05-.18-.1-.12-.5-.24-.74-.12-.25.12-.2,0-.2-.06s-.1-.06-.25-.06.2-.12,0-.18c-.2-.06-.4.06-.35,0,.05-.06.2-.24,0-.24s-.79-.06-.99,0c-.2.06-.35.18-.45.24-.1.06,0,0-.1-.06-.1-.06-.4-.18-.45-.06-.05.12-.2.36-.25.24-.05-.12.05-.18.1-.3.05-.12.05-.06-.05-.18-.1-.12-.3-.12-.25-.24.05-.12.05-.24-.2-.18-.25.06-.6,0-.74.06-.15.06-.1.18-.2.18s-.2-.06-.3,0c-.1.06-.25,0-.3.18-.05.18.35.3.3.36-.05.06-.25-.06-.25.06s.25.18.3.24c.05.06,0,.18-.1.12q-.1-.06-.25-.18c-.15-.12-.2-.12-.25-.24s-.2-.12-.15-.24c.05-.12.1-.18.25-.24.15-.06.35-.12.4-.18.05-.06-.35-.18-.74-.12-.4.06-.99.12-1.19.79-.2.67.3.48.65.48s.4.12.25.12-.65-.06-.69,0c-.05.06.1.12.25.18.15.06.05.24.25.18.2-.06.25-.12.45-.06.2.06.05.12.3.12h.54c.15,0,.55-.12.65,0q.1.12.3.12c.2,0,.3-.12.45-.06.15.06.3.24.55.18.25-.06.54-.06.5-.18-.05-.12-.3-.24-.3-.24,0,0,.25,0,.35.06.1.06.35.12.4.06.05-.06-.2.18-.05.24.15.06.3-.12.35,0,.05.12.35.24.45.24s-.45,0-.4.12c.05.12.05.3.2.18.15-.12.3-.24.45-.18.15.06.05,0,0,.12-.05.12-.4.18-.45.18s-.5-.06-.45.18c.05.24.2.42.35.36.15-.06.5.12.55-.12.05-.24.05-.3.1-.36.05-.06,0-.18.15-.18s.2-.12.3.06c.1.18.2-.06.35.18.15.24.35.36.25.42-.1.06-.35.18-.5.36-.15.18-.35.12-.4.12s.35.24.35.3-.25,0-.35.06c-.1.06-.25.06-.4.06s-.55,0-.65-.06c-.1-.06-.25-.12-.2,0l.05.12Z");
    			attr(path47, "d", "m4.33,14.42c-.1-.06-.4-.12-.4,0s-.05.18-.15.18-.2-.06-.3,0c-.1.06-.15.24-.25.3-.1.06,0,.18.05.12.05-.06,0-.24.2-.24s.3.06.4,0c.1-.06.25-.18.35-.18s.1-.18.1-.18Z");
    			attr(path48, "d", "m2.89,14.84c-.1.06-.2.12-.25.12s-.2.18-.1.18.3.06.35-.06c.05-.12,0-.24,0-.24Z");
    			attr(path49, "d", "m.75,15.27c.1.06.2-.12.3-.12s.1.12.25.12.4-.12.45-.06c.05.06,0,.18-.1.18s-.35-.06-.45,0c-.1.06-.2.12-.3.06-.1-.06-.15-.18-.15-.18Z");
    			attr(path50, "d", "m0,15.51c.05-.12.1-.18.2-.12.1.06.05-.06.15-.06s.2.06.15.12c-.05.06-.15.06-.25.12-.1.06-.3.06-.25-.06Z");
    			attr(path51, "d", "m4.28,11.27s.3.06.25.24c-.05.18-.2.18-.35.12-.15-.06-.45-.12-.45-.18s.2,0,.3-.06c.1-.06.15-.18.25-.12Z");
    			attr(path52, "d", "m1.99,9.75c.05-.06.2-.12.25-.06.05.06.25,0,.35,0s.15,0,.25.12c.1.12.25,0,.35.06.1.06-.05.12-.15.18-.1.06-.15.18-.25,0-.1-.18-.3-.12-.4-.18-.1-.06-.3.18-.35.06-.05-.12-.05-.18-.05-.18Z");
    			attr(path53, "d", "m46.01,65.74c.15,0,.25.12.2-.06-.05-.18-.1-.24.05-.24s.4-.06.45.06c.05.12.05.06.15,0,.1-.06.35-.06.45,0,.1.06.1.18-.05.24-.15.06-.25,0-.3.18-.05.18-.3.18-.35.12-.05-.06.05-.18-.1-.18s-.2.12-.3.12-.2-.06-.25-.12c-.05-.06,0-.12.05-.12Z");
    			attr(path54, "d", "m29.78,5.14s.1,0,.25.12.4.12.4,0-.1-.12-.25-.18c-.15-.06-.35,0-.2-.12.15-.12.25-.3.4-.24.15.06.4.12.55.06.15-.06.59-.12.59-.12,0,0,.4.12.3.18-.1.06-.35.24-.45.3-.1.06.1-.06.2.06.1.12.05-.18.25.06.2.24,0,.61,0,.61,0,0-.4-.18-.5,0-.1.18-.15.3-.35.18-.2-.12-.3-.36-.5-.36s-.54-.06-.65-.12c-.1-.06-.25-.06-.3-.18s.15-.24.25-.24Z");
    			attr(path55, "d", "m21.59,3.5c.1-.03.69-.12.84-.18.15-.06.4-.36.69-.3.3.06.59-.12.79-.06.2.06.45,0,.35.18-.1.18.25.3-.05.36-.3.06-.4.24-.55.18-.15-.06-.1,0-.2-.12-.1-.12.05-.24-.1-.18-.15.06-.35.36-.5.36s-.25.24-.45.12c-.2-.12-.25-.18-.4-.12-.15.06-.35.12-.45.06-.1-.06-.2-.24,0-.3Z");
    			attr(path56, "d", "m23.68,3.99s.1-.18.2-.18.25-.12.35-.18c.1-.06.25-.06.45-.06s.5-.06.74.06c.25.12.3.06.55.18.25.12.55.18.74.18s.35-.12.15-.18c-.2-.06-.45-.18-.35-.24.1-.06.3,0,.45-.12s.3.12.4.24c.1.12.3,0,.5,0s.89-.06.55.24c-.35.3-.5.42-.79.36-.3-.06-.65-.06-.79,0-.15.06-.89.36-1.04.3-.15-.06-.65-.06-.74-.12-.1-.06-.1-.18.1-.18s.15-.06,0-.12q-.15-.06-.35,0c-.2.06-.35.18-.45.06-.1-.12-.2,0-.35-.06-.15-.06-.3.06-.35,0-.05-.06-.05-.12.05-.18Z");
    			attr(path57, "d", "m26.48,3.05c-.09.04-.25.06-.45.06s-.3.12-.45,0c-.15-.12-.15-.18-.25-.18h-.25c-.15,0-.3,0-.4-.06-.1-.06-.1-.12-.1-.12,0,0,.35-.06.5,0,.15.06.2.12.2,0s0-.24.05-.24.3-.06.4-.06.45-.06.55-.06.35-.06.4,0c.05.06.25.06.2.12-.05.06-.05.18-.15.18s.12.15-.02.15-.2,0-.2.06.05.12-.03.15Z");
    			attr(path58, "d", "m28.34,3.08s.05.12.35.06c.3-.06.05-.06-.1-.12-.15-.06-.35-.18-.35-.18,0,0-.2-.06.1.24Z");
    			attr(path59, "d", "m28.64,4.11c.05-.06.25-.18.3-.12.05.06.2.12.15.18-.05.06-.1.06-.25.06s-.25-.06-.2-.12Z");
    			attr(path60, "d", "m28.54,2.04s.89.06.89.12.2.06.3.06.4-.06.5.06c.1.12.25-.12.35.06.1.18.05.24.2.3.15.06.35.12.15.18-.2.06-.5.12-.6,0-.1-.12-.1-.24-.2-.18-.1.06-.15.24-.3.18-.15-.06-.2-.12-.35-.18-.15-.06-.05-.06-.25,0-.2.06-.4.12-.5.06-.1-.06-.25-.12-.2-.18.05-.06.35-.06.45-.06s.25-.06.1-.12c-.15-.06-.3-.06-.45-.06h-.3c-.1,0,.05-.24.2-.24Z");
    			attr(path61, "d", "m28.89,3.38s.65.18.74.3c.1.12.35.12.2,0-.15-.12-.2-.3-.05-.24.15.06.3,0,.4-.06.1-.06.3-.18.4-.06.1.12.35.06.45.06s.45-.06.5.06c.05.12.05.42,0,.48-.05.06.1.18-.05.24-.15.06-.54.18-.69.12-.15-.06-.45,0-.4-.12q.05-.12.1-.18c.05-.06-.15,0-.3,0s-.45.06-.6,0c-.15-.06-.15-.12-.3-.18-.15-.06-.35-.06-.45-.12-.1-.06-.25-.3.05-.3Z");
    			attr(path62, "d", "m30.48,1.74s.5-.12.55,0c.05.12.05.18-.05.18s-.1-.12-.2-.12-.35.06-.3-.06Z");
    			attr(path63, "d", "m31.37,2.35s.4.12.69.12.6,0,.55.12c-.05.12-.15.24-.25.24s-.4,0-.45.06c-.05.06-.35-.06-.3-.12.05-.06,0-.06-.15-.12-.15-.06-.3-.3-.1-.3Z");
    			attr(path64, "d", "m32.06,3.02h.84c.15,0,.4-.06.4-.12s-.3.06-.4,0c-.1-.06-.65-.06-.69,0-.05.06-.45.06-.15.12Z");
    			attr(path65, "d", "m31.82,3.26s1.14-.18,1.34,0c.2.18.25.24.55.18.3-.06.55-.12.65,0s.5,0,.45.12c-.05.12-.15.24,0,.3.15.06.3-.06.45,0,.15.06.2.06.4.12.2.06.25,0,.35-.06.1-.06.45-.18.69-.12.25.06.25,0,.59,0s.79-.06.94.06c.15.12.35,0,.45.12.1.12.05.18-.05.3-.1.12-.05.3-.3.24-.25-.06-.74,0-.84,0s-.1-.06-.2-.12c-.1-.06,0,0-.2.06-.2.06-1.89.06-1.89.06,0,0-.15,0-.1-.12.05-.12-.2-.06-.35,0-.15.06-.45,0-.64,0s-.3.06-.4-.12c-.1-.18-.3-.06-.2-.18.1-.12.2-.24.15-.3-.05-.06-.35-.24-.6-.18-.25.06-.45.06-.3.18.15.12.5.36.45.42-.05.06.1.24-.15.18-.25-.06-.74-.12-.89-.12s-.35.06-.25-.06c.1-.12-.05-.12-.1-.18-.05-.06.05-.12.25-.12s.45.06.5,0c.05-.06.05-.18-.05-.24-.1-.06-.4-.18-.55-.24-.15-.06-.45-.12-.15-.18Z");
    			attr(path66, "d", "m35.09,3.56h.64c.2,0,.4.06.6,0,.2-.06.4-.06.6-.06s.89-.06,1.04,0c.15.06,0,.06.1.12.1.06.6.06.65,0,.05-.06.3,0,.45-.06.15-.06.3-.18.25-.24-.05-.06-.25-.06-.4-.06s-.15-.18-.05-.18.5.06.45-.12q-.05-.18.3-.18c.35,0,.6.06.69-.12.1-.18.5-.12.35-.3-.15-.18.05-.3.2-.3s.79,0,1.04-.12c.25-.12.54-.24.79-.3.25-.06.35-.24.94-.3.6-.06.94-.12.94-.18s0-.12.35-.18c.35-.06.99-.18.99-.24s-1.19-.42-1.74-.36c-.54.06-2.03-.12-2.33-.12s-2.09,0-2.28.06c-.2.06-1.44.06-1.79.12-.35.06-.4.3-.5.3s-.84-.06-1.04-.06-.45.06-.6.12c-.15.06,0-.06-.35,0-.35.06-1.04-.06-1.29.06-.25.12-.5.18-.35.24.15.06.74-.18.79-.06.05.12-.45.06-.1.24.35.18.5.18.74.18h.69c.2,0-.05.18.35.12.4-.06.65,0,.84-.06.2-.06.1,0,.5,0s.64-.06.84-.06-.05.18-.84.18-.1.12,0,.18c.1.06-.05.12-.4,0-.35-.12-.84-.18-.99-.12-.15.06-.45.18-.25.24.2.06.59,0,.64.12.05.12-.15.24-.35.24s-.69.12-.69.24.2.18.4.18.4-.24.54-.06c.15.18-.1.3.1.3s.6-.06.65-.12c.05-.06-.05.42-.84.24-.79-.18.2-.3-.79-.24-.99.06.2.24.1.3-.1.06-.35.06-.54.06s-.35-.06-.35.06.05.3.3.3Z");
    			attr(path67, "d", "m34.1,2.95s.3-.06.45.06.1.06-.05.12c-.15.06-.2.24-.3.12-.1-.12-.25-.3-.1-.3Z");
    			attr(path68, "d", "m32.86,1.14s.6,0,1.04.24c.45.24.6.18.74.18s-.05.18.15.18.15-.06.3-.12c.15-.06.35-.06.35.06s.1,0,.2.12c.1.12.05.24.2.24s.59,0,.54.06c-.05.06-.4.18-.54.18s-.45.12-.6.24c-.15.12-.45.24-.55.18-.1-.06-.3,0-.45,0s-.35.12-.55,0c-.2-.12-.1-.06-.3-.12-.2-.06-.1,0-.3-.12-.2-.12-.2-.36.25-.3.45.06.2-.06-.5-.06s-.55.06-.6-.06c-.05-.12-.1-.12-.2-.18-.1-.06-.2-.24,0-.24s.25,0,.3-.18c.05-.18.2-.18.3-.18s.1-.12.2-.12Z");
    			attr(path69, "d", "m38.31,4.78s.45.12.74.06c.3-.06.5.06.6.12.1.06.45.18.4.24-.05.06-.25,0-.45,0s-.4.06-.55.12c-.15.06-.35.18-.45,0q-.1-.18-.25-.24c-.15-.06-.35-.3-.05-.3Z");
    			attr(path70, "d", "m43.5,1.71s.1-.18.3-.18.79-.3,1.04-.3.4,0,.64.06c.25.06.3,0,.3-.12s-.03-.33.52-.27c.54.06.5-.06.4-.12-.1-.06,1.84-.24,1.94-.06.1.18.15.3.3.18.15-.12.2-.24.5-.12.3.12.59.18.54.06-.05-.12-.89-.55.45-.3,1.34.24,1.89.61,1.69.42-.2-.18-1.24-.36-1.19-.49.05-.12.25-.06,1.04-.18.79-.12,2.23.06,2.48-.06.25-.12,3.42-.36,5.06-.12,1.64.24,2.08.36,1.84.48-.25.12-3.82.18-3.92.3-.1.12,2.23-.12,2.88-.06.65.06-.5.18-.54.24-.05.06.45.12.94-.06q.5-.18.59-.06c.1.12.25.06.3,0,.05-.06-.05-.3.1-.24.15.06.45.3.2.36-.25.06-.74.18-.74.3s.2,0,.4-.06c.2-.06.69-.3.94-.24.25.06.6,0,.84,0s.6-.12.79-.12.99,0,1.04.06c.05.06-.05.12-.3.18-.25.06-.69.18-.69.18,0,0,0,.18-.15.12-.15-.06-.55-.12-.6-.06-.05.06.4.12.25.18-.15.06-.25.06-.4.18-.15.12-.15.24-.25.18-.1-.06-.3-.06-.4,0-.1.06-.05.06,0,.18.05.12,0,.3-.2.24-.2-.06-.2-.12-.3-.06-.1.06-.15.36-.25.36s-.25.12-.2.18c.05.06.2-.12.35-.12s.5-.06.55.06c.05.12.2.18.1.18s-.3,0-.35.06c-.05.06.35.06.5.06s.3.18.15.24c-.15.06-.3.06-.15.18.15.12.25.3.1.24-.15-.06-.2-.24-.3-.36-.1-.12-.5-.12-.6-.06-.1.06-.1.18-.2.12-.1-.06-.3-.18-.35-.18s.1.12.15.18c.05.06,0,.24.15.18.15-.06.25-.3.35-.18.1.12.55.36.45.48-.1.12-.1.24-.25.18-.15-.06-.25-.12-.3-.06-.05.06,0,.12.1.12s.25.06.25.12.05.12.15.06c.1-.06.2,0,.2-.12s.1-.36.15-.3c.05.06.15.06.25.06s.35.12.25.18c-.1.06-.2,0-.3,0s-.25.12-.3.24c-.05.12-.1.24-.3.18-.2-.06-.25-.12-.3-.12s.15.12,0,.12-.45-.12-.59-.06c-.15.06-.15.18,0,.12.15-.06.5-.06.54,0,.05.06.1.18,0,.24-.1.06-.25.06-.35.06s-.3.06-.4.06-.4-.06-.45-.12-.25-.12-.3-.12-.1.06-.05.12c.05.06.1,0,.25.06.15.06.2.12.35.12s.3-.06.35.06c.05.12,0,.24,0,.3s-.05.12-.1.12-.2,0-.3-.06c-.1-.06-.1,0-.2-.06-.1-.06-.3-.06-.35-.12-.05-.06-.1-.18-.15-.18s-.15.06-.05.12c.1.06.15.24.25.24s.25,0,.35.06c.1.06.3,0,.35.12.05.12.3.06.3.18s0,.3.05.36q.05.06-.05.12c-.1.06-.25.06-.4.06s-.5-.06-.54-.12c-.05-.06-.05-.18-.1-.24-.05-.06-.2-.12-.3-.12s-.25.06-.2.12c.05.06.1.18.1.24s.55.24,1.19.24-.55.18-.84.36c-.3.18-1.59.48-1.69.48s-.74.18-.94.12c-.2-.06-.25.06-.35-.06-.1-.12-.4-.3-.3-.18.1.12.4.3.25.36-.15.06-.35.06-.5.3-.15.24-.84.61-1.04.61s-.15,0-.25.12c-.1.12-.25.12-.25.06s-.05,0-.2-.06c-.15-.06-.05-.12,0-.18.05-.06-.1-.12-.2.18-.1.3-.55,0-.65.06-.1.06.05.06.1.12.05.06-.1.12-.35.12s-.1.06,0,.18.15.18,0,.24c-.15.06.05.12,0,.24-.05.12-.45.42-.6.49-.15.06-.1.06-.05.24.05.18-.2.3-.2.48s-.05.3-.15.36c-.1.06.05.18-.05.24-.1.06-.65.12-.84-.06-.2-.18-.35-.3-.55-.3s-.59.24-.65.06c-.05-.18-.25-.36-.45-.49-.2-.12-.4-.42-.45-.54-.05-.12-.2-.3-.3-.3s-.2-.36-.3-.36-.25-.24-.2-.36c.05-.12-.05-.3-.15-.3s-.35-.12-.35-.24-.25-.24-.05-.24.35-.12.3-.18c-.05-.06-.35.06-.35-.06s.1-.54.25-.61c.15-.06.2-.36.3-.3.1.06.25.18.35.12.1-.06.15-.06.2-.18.05-.12-.05-.24.05-.24s-.1-.06-.15-.12c-.05-.06-.15-.06-.25-.12-.1-.06-.69-.12-.74-.18-.05-.06-.35-.24-.25-.24s.84.06.99.12c.15.06.54.18.5.06-.05-.12-.45-.24-.54-.3-.1-.06-.4-.12-.4-.24s-.3.18-.5.12c-.2-.06-.6.06-.55-.12.05-.18.2-.24.2-.36s-.1-.12-.2-.18c-.1-.06,0-.24.1-.3.1-.06-.25-.3-.35-.36-.1-.06-.4-.36-.5-.42-.1-.06-.55-.42-.65-.42s-.64-.18-.84-.12c-.2.06-.54,0-.64-.06-.1-.06-.2,0-.3.06-.1.06-.15-.06-.4.06-.25.12-.4-.06-.5-.12-.1-.06-.2.24-.4.18-.2-.06-.69-.06-.84-.18s-.15-.12-.25-.18c-.1-.06-.2.06-.35-.06-.15-.12-.15-.06-.25-.12-.1-.06.4-.12.69-.12s1.09,0,1.19-.12c.1-.12-1.24.06-1.34,0-.1-.06-.15-.18-.35-.18s-.4,0-.55-.06c-.15-.06-.45-.12-.2-.18.25-.06.74-.12.89-.18.15-.06.4-.18.6-.18s1.09.06,1.19,0c.1-.06.4-.12.5-.18.1-.06.15-.18.1-.24-.05-.06-.15,0-.3,0h-.45c-.15,0-.55,0-.42-.09Z");
    			attr(path71, "d", "m48.51,6.5s.2,0,.4.06c.2.06.35.12.45.12s.35.06.25.12c-.1.06-.3.12-.45.18-.15.06-.3.18-.35.06-.05-.12-.15-.12-.25-.12s-.15-.06-.15-.12.05-.3.1-.3Z");
    			attr(path72, "d", "m60.67,8.69c.15-.12.22-.21.37-.15.15.06.25-.06.1-.12-.15-.06-.05-.3.35-.06.4.24.15.3.35.42.2.12.05-.12.2-.06.15.06.1-.06.15-.18.05-.12.1-.06.25.06s.15-.18.3-.18.1.3.25.18c.15-.12.2-.18.35-.12.15.06.4,0,.4-.06s.05-.24.2-.12c.15.12.25.24.4.18.15-.06.05.12.2.18.15.06.4.06.4.18s-.3.42-.5.49c-.2.06-.35.12-.45.24-.1.12-.45.12-.6.12s-.1.06-.3.12c-.2.06-.55.06-.65,0-.1-.06-.2-.06-.4-.12-.2-.06-.5.12-.69,0-.2-.12-.3-.18,0-.18s.25.06.15-.12c-.1-.18-.05-.24-.2-.24s-.5.06-.54.06-.15-.06.2-.12q.35-.06.4-.12c.05-.06-.05-.12-.25-.12s-.2.12-.35.06c-.15-.06-.25.06-.25-.06s.17-.15.17-.15Z");
    			attr(path73, "d", "m67.49,12.3s.2.06.2-.06.15-.12.15-.06-.05.18-.1.24c-.05.06-.15.12-.2.18s-.05.18-.1.18,0,.12-.05.18c-.05.06-.1.12-.15.12s0-.06,0-.12v-.24c0-.06-.05-.24.05-.18.1.06.1,0,.1-.06s.05-.18.1-.18Z");
    			attr(path74, "d", "m87.69,49s0,.42.1.67c.1.24.1.55.05.67-.05.12-.15.54-.25.61-.1.06-.2.18-.2.3s.25.61.25.73-.15.24-.1.36c.05.12.45.61.55.67.1.06.15.06.25,0,.1-.06.3-.18.45-.18s.25-.36.3-.61c.05-.24.74-2.43.79-2.61.05-.18.1-.36.05-.49-.05-.12,0-.24.05-.3.05-.06,0-.3,0-.48s0-.18.1-.06c.1.12.2.06.2-.12s.05-.24-.05-.48c-.1-.24-.05-.67-.2-.91-.15-.24-.25-.48-.3-.36-.05.12-.15.36-.1.42.05.06.1.18-.05.24-.15.06-.2-.06-.25.06-.05.12-.1.3-.05.42.05.12-.05,0-.2.12-.15.12-.1.18-.3.3-.2.12-.35.36-.5.36s-.2.06-.3.12c-.1.06-.2-.12-.2,0s.05.55-.1.55Z");
    			attr(path75, "d", "m92.2,50.63s.2.06.2.18-.1.3-.2.18c-.1-.12-.1-.36,0-.36Z");
    			attr(path76, "d", "m93,50.33c.05-.06.2-.12.2,0s.05.3-.05.3-.2,0-.2-.12.05-.18.05-.18Z");
    			attr(path77, "d", "m83.07,23.58s.15-.06.2-.06.05-.06.15-.06.2,0,.25-.06c.05-.06.35-.18.25-.06-.1.12-.1.24-.15.3-.05.06-.15.06-.2.12-.05.06-.25.24-.35.12-.1-.12-.3-.24-.15-.3Z");
    			attr(path78, "d", "m79.55,23.4c.05-.06.15-.24.2-.12.05.12.1.12.25.12s.3,0,.35.06c.05.06.1,0,.2,0s.25.06.15.12c-.1.06-.2.06-.35.12-.15.06-.3-.12-.35-.12h-.2c-.1,0-.3-.12-.25-.18Z");
    			attr(path79, "d", "m73.65,20s.2-.12.25-.12.05-.24.1-.18c.05.06.05.36.05.42s0,.3-.05.36c-.05.06.2.24.15.3-.05.06-.1.61-.05.73.05.12-.1.12-.15.12s-.05.06-.15.12c-.1.06-.15.06-.2-.06-.05-.12,0-.24,0-.3s.05-.3-.05-.36c-.1-.06-.15-.24-.1-.24s.15-.06.25-.12c.1-.06.2-.12.15-.18-.05-.06-.2-.06-.2-.18s-.05-.3,0-.3Z");
    			attr(path80, "d", "m71.16,21.4c.05-.06.2-.24.25-.18.05.06.1.06.15.06s.15.06.1.12c-.05.06-.2.3-.25.18s-.1-.12-.15-.12-.15,0-.1-.06Z");
    			attr(path81, "d", "m71.81,21.15s.2.06.2.12-.05.12-.1.06c-.05-.06-.1-.12-.15-.12s0-.06.05-.06Z");
    			attr(path82, "d", "m70.72,21.7c.05-.06.1-.12.15-.06.05.06.1.06.05.12-.05.06-.1.12-.15.06-.05-.06-.1-.06-.05-.12Z");
    			attr(path83, "d", "m78.51,57.37s.25.18.45,0c.2-.18.65-.24.94-.18.3.06.4.18.74,0,.35-.18,1.64-1.27,1.89-1.94.25-.67.74-.79.74-1.15s.1-.79,0-.85c-.1-.06.25-.42.65-.55.4-.12.5-1.46.25-2.18-.25-.73.05-.48.6-.97.55-.48,1.29-.73,1.39-.97.1-.24.35-1.33.2-2.61-.15-1.27-.5-.48-.4-1.82.1-1.33-.3-1.15.35-2.31.65-1.15,1.49-1.64,2.08-2.37.6-.73,1.64-2.06,1.89-3.16.25-1.09.4-1.64.25-1.58-.15.06-.3.24-.74.3-.45.06-.89.06-.94.24-.05.18-.45,0-.74.18-.3.18-.55-.49-.74-.55-.2-.06.25-.06.2-.18-.05-.12-.4-.55-.55-.73-.15-.18-.55-.79-.69-.73-.15.06-.35-.3-.4-.49-.05-.18-.25-1.21-.4-1.27-.15-.06-.35.12-.4-.12-.05-.24-.2-1.4-.3-1.64-.1-.24-.4-.67-.45-.79-.05-.12-.55-1.09-.6-1.27-.05-.18-.2-.61-.3-.73-.1-.12-.2-.42-.25-.48-.05-.06-.2-.3-.15-.42.05-.12.5.91.6.97.1.06.2,0,.25-.06.05-.06.2-.06.3.12.1.18.6.79.55.91-.05.12.1.48.25.67.15.18.65.55.65.79s0,1.03.25,1.21c.25.18.69.55.79,1.09.1.55.5.3.5.73s-.05.67,0,.85.2.97.4,1.03c.2.06.69-.06.79-.24.1-.18.4.12.55,0,.15-.12.4-.36.5-.36s.25.06.35-.12.25-.3.5-.3.69-.12.69-.3.1-.36.25-.42c.15-.06.45-.24.69-.24s.3-.24.35-.36c.05-.12.3,0,.4-.12.1-.12.05-.18.15-.3.1-.12.4-.18.4-.24s0-.55.15-.67c.15-.12.25-.06.3-.36.05-.3.25-.18.3-.36.05-.18.05-.3-.15-.48-.2-.18-.35-.3-.6-.36-.25-.06-.69-.54-.6-1.15.1-.61-.4.67-.79.79-.4.12-.84.12-.89.24,0,0-.1-.24-.25-.18-.15.06.15-.3.1-.48-.05-.18-.1-.42-.25-.3-.15.12-.05.36-.15.36s-.2-.12-.2-.36.25-.24,0-.36c-.25-.12-.59-.67-.64-.85-.05-.18-.25-.24-.25-.36s.25-.24.3-.3.4-.06.45-.12c.05-.06.15,0,.2.12s.35.73.35.85,0,.36.2.24c.2-.12.3.06.45.18.15.12.5.3.64.24.15-.06.25.06.4-.06.15-.12.59-.24.65,0,.05.24-.15.42.1.48.25.06,1.04.18,1.24.24.2.06.7.24.79.12.1-.12,1.34-.3,1.49-.24.15.06.05.3.15.36.1.06.25.06.3.24s.15.3.25.3.3.24.35.36.5,0,.55,0,.05.24-.15.24-.4,0-.35.06c.05.06.35.42.4.55.05.12.2.3.35.24.15-.06.45-.12.5-.24.05-.12.15-.67.2-.49.05.18.05.61.1.73.05.12-.2.24-.1.48.1.24.1.91.2,1.03.1.12.05.67.15.85.1.18.45.85.45,1.15s.4.85.45,1.03c.05.18.2.97.25,1.15.05.18.45.55.5.42.05-.12.1-.18.2-.3.1-.12.4-.24.4-.36s.05-.36.15-.36.2-.18.15-.36c-.05-.18.1-.79.15-.85.05-.06.05-.61,0-.85-.05-.24,0-.73.25-.67.25.06.2-.06.3-.18.1-.12.4-.12.35-.36-.05-.24.2-.12.4-.36.2-.24.5-.79.69-.85.2-.06.84-.42.79-.61-.05-.18-.1-.36.1-.36s.94.24,1.14-.06.3-.54.4-.48c.1.06.1.36.2.55.1.18.2.48.45.61.25.12.2.24.2.48s.15.18.25.3c.1.12.25.85.1,1.09-.15.24,0,.24.15.3.15.06.35.06.45-.12.1-.18.35-.3.4-.36.05-.06.15-.18.15-.06s.2.42.2.61,0,.48.1.73c.1.24.35.61.3.73s-.15.36-.1.48c.05.12.1.36.05.36s0,.48-.05.61c-.05.12-.05.3-.1.42-.05.12-.2.42,0,.42s.3-.12.35.06c.05.18.45.73.45.91s0,.3.05.42c.05.12.3.42.3.67s0,.36.1.42c.1.06.79.61.84.67.05.06.25.18.3.06.05-.12-.15-.49-.2-.73-.05-.24.05-.85-.05-1.03-.1-.18-.79-1.03-.89-1.03s-.25,0-.3-.12-.25-.67-.25-.85-.05-.24-.15-.24-.1-.06-.1-.24.15-.79.25-.91c.1-.12,0-.61.05-.73.05-.12.2-.36.25-.12.05.24.05.48.15.48s.35-.12.4,0c.05.12,0,.36.1.36s.2,0,.25.12c.05.12,0,.36.1.36s.3,0,.3.06.05.24.15.24.35.06.3.12c-.05.06-.2.18-.15.3.05.12-.05.42,0,.42s.5-.36.59-.49c.1-.12.25-.18.25-.3s.15-.12.25-.18c.1-.06.69-.3.69-.67s.05-.97-.1-1.45c-.15-.49-.45-.79-.6-.91-.15-.12-.4-.42-.4-.54s-.1-.24-.2-.3c-.1-.06-.15-.36-.1-.49.05-.12.2-.18.3-.3.1-.12.15-.18.2-.3.05-.12.1.06.2-.06.1-.12.1-.3.15-.3s.3,0,.35-.06c.05-.06.35-.06.35,0s-.05.12,0,.24c.05.12,0,.3.1.36.1.06.4.12.35,0-.05-.12-.2-.24-.1-.36.1-.12.55-.06.65-.18.1-.12.55-.12.55-.24s.05-.55.1-.42c.05.12.1.3.2.3s.55-.3.6-.3.4,0,.5-.18c.1-.18.4-.48.5-.55.1-.06.55-.42.6-.61.05-.18.1-.48.15-.55.05-.06.45-.54.5-.67.05-.12.2-.3.2-.42s.1-.36.15-.48c.05-.12.05-.24-.05-.18-.1.06-.25.12-.25.06s-.15-.12-.25-.06c-.1.06-.25.12-.25.06s.3-.06.35-.18c.05-.12.15-.12.25-.12s.15-.12.05-.18c-.1-.06-.05-.18,0-.24.05-.06.05-.24-.05-.3-.1-.06-.35-.18-.35-.36s-.05-.36-.1-.42c-.05-.06-.3-.18-.35-.24-.05-.06-.2-.12-.25-.18-.05-.06.05-.12.15-.24.1-.12.35-.42.45-.48.1-.06.35-.24.45-.24s.35.06.35-.12-.05-.36-.2-.3c-.15.06-.3.12-.35,0-.05-.12-.25-.12-.35,0-.1.12-.25.3-.35.24-.1-.06-.2-.3-.15-.42.05-.12-.3,0-.4-.06-.1-.06-.25-.18-.2-.3.05-.12.25-.18.3-.12.05.06.35-.06.4-.24.05-.18.15-.18.25-.18s.2-.12.25-.24.45-.24.55-.12c.1.12-.05.18-.1.3s-.45.12-.25.24c.2.12.25.24.1.24s-.2.18-.1.18.25,0,.35-.12c.1-.12.65-.55,1.04-.36.4.18.35.36.25.42-.1.06-.3.24-.2.36.1.12.3.3.4.18.1-.12.35,0,.3.18-.05.18-.3.12-.2.24.1.12.3.42.25.55-.05.12-.35.24-.25.36.1.12-.05.24.1.3.15.06.3.12.4,0,.1-.12.35,0,.5-.12.15-.12.59-.48.45-.79s-.15-.97-.54-1.21c-.4-.24-.35-.06-.3-.3.05-.24.15-.12.25-.3.1-.18.59-.18.64-.49.05-.3-.15-.42,0-.42s.74-.42.79-.61c.05-.18.1-.24.25-.06.15.18.35.24.59.18.25-.06.5-.18.6-.36.1-.18.84-.97.99-1.09.15-.12.3-.42.35-.54.05-.12.5-.49.59-.61.1-.12.15-.91.15-1.15s.25-.55.3-.67c.05-.12-.05-.12-.05-.3s.15-.24.05-.36c-.1-.12-.4-.12-.4-.24s-.25-.24-.45-.18c-.2.06-.15-.12-.2-.06-.05.06,0,.36-.1.36s-.35.06-.35-.06,0-.18-.05-.24c-.05-.06-.2.24-.25.12-.05-.12.1-.24,0-.3-.1-.06-.3.12-.4,0-.1-.12-.35-.06-.05-.24.3-.18,1.04-.67,1.14-.85.1-.18.5-.42.64-.48.15-.06.45-.12.5-.24s.25-.3.4-.36c.15-.06,1.24-.24,1.39-.12q.15.12.25.06c.1-.06.45.06.74,0,.3-.06.25-.3.45-.24.2.06.15.12.4.12s.5-.06.35.06c-.15.12-.2.24,0,.24s.59-.18.89-.12c.3.06.5.06.54-.06.05-.12-.05-.06-.2-.12-.15-.06-.25-.12-.05-.24.2-.12.89-.49.94-.67.05-.18.3-.24.6-.24s.59.12.69.06c.1-.06.35-.12.2,0s-.4.36-.25.36,0,.24.15.24.4-.3.55-.36c.15-.06.4-.18.55-.18s.15-.06.05-.18c-.1-.12-.15-.24.15-.3.3-.06.45-.12.35,0-.1.12-.2.24-.2.36s-.05.36-.2.36-.55.18-.65.36c-.1.18-.5.36-.69.42-.2.06-.15.42-.45.49-.3.06-.45.3-.6.3s-.45-.18-.35,0c.1.18.35.12,0,.3-.35.18-.55.91-.45,1.09.1.18.35,1.09.3,1.21-.05.12.1.12.1.3s-.05.3.05.42.1,0,.3-.12c.2-.12.35-.24.4-.36.05-.12.05-.55.15-.55s.4-.06.5,0c.1.06-.1-.3-.05-.48.05-.18.25-.3.5-.24.25.06.45.06.45-.06s-.15-.3-.2-.42c-.05-.12.2-.42.35-.3s.4.12.35,0c-.05-.12-.05-.3-.2-.3s-.2-.06-.1-.18c.1-.12.35-.3.25-.36-.1-.06-.35.18-.4,0-.05-.18,0-.36.1-.42.1-.06.35-.3.35-.42s0-.06.2-.12c.2-.06.15.18.3.12.15-.06.5-.48.54-.36.05.12-.15.36.05.3.2-.06.74-.55,1.09-.36.35.18.54.67.59.42.05-.24.6-.61.79-.67.2-.06.79-.36.89-.42.1-.06.4,0,.6-.12.2-.12.55-.24.74-.12.2.12.55.3.55.12s.05-.42-.05-.55c-.1-.12-.2-.12-.25-.3-.05-.18-.2-.12-.35-.18-.15-.06-.2-.06-.15-.12.05-.06.59,0,.74-.06.15-.06.25-.12.3-.12s0-2,0-2c0,0-.6-.24-.84-.24s-.79-.18-.99-.18-.89.18-1.19.06c-.3-.12-.89-.18-.84-.12.05.06.2.24.2.36s-.25.3-.35.24c-.1-.06-.15,0-.2-.06-.05-.06-.4,0-.45-.12-.05-.12.2.06.3-.12.1-.18.2-.18-.05-.24-.25-.06-.45.06-.65.12-.2.06-1.09.12-1.24.06-.15-.06-1.14,0-1.29,0s-.45.06-.45-.06.25-.24.1-.36c-.15-.12-.69-.48-1.74-.3-1.04.18-1.29.24-1.39.12-.1-.12-.3-.3-.94-.36-.65-.06.3-.12.1-.24-.2-.12-1.14,0-1.29-.12-.15-.12-1.88-.12-2.08-.24-.2-.12-.55-.06-.45,0,.1.06-.69.24-.5.3.2.06.35.3.2.3s-.35,0-.6-.06c-.25-.06-.79-.06-.99,0-.2.06-.4.24-.6.18-.2-.06-.35-.18-.45-.36-.1-.18-.5.48-.55.54-.05.06-.3.18-.35.06-.05-.12-.4-.06-.55-.18-.15-.12-.3-.24-.2-.3.1-.06.25-.06.25-.24s.1-.3,0-.36c-.1-.06-.64-.3-1.14-.24-.5.06-.55.12-.69-.06-.15-.18-.25-.18-.3-.06-.05.12-.4,0-.35.18.05.18.05.36-.1.3-.15-.06-.74.06-.94-.06-.2-.12-.5-.36-.45-.18.05.18-.1.24-.25.12-.15-.12.15-.06,0-.18-.15-.12-1.39-.18-1.74-.12-.35.06-.45-.06-.4.06.05.12-.1.3-.15.12-.05-.18-.05-.36-.15-.3-.1.06-.35.06-.6,0-.25-.06-.69-.18-.65,0,.05.18.2.3-.05.24-.25-.06-.55-.12-.74,0s-.55.12-.55.12c0,0,.74-.36.89-.42.15-.06.69-.18.89-.24.2-.06.54,0,.64-.12.1-.12.5-.06.55-.24s.2-.48-.1-.48-.2.18-.5-.06c-.3-.24-.79-.12-.99-.12s-.74.06-.89.06.1-.06.05-.18c-.05-.12-.15-.18-.5-.12-.35.06.15-.24-.25-.24s-1.64.12-1.79.3c-.15.18.05.18,0,.24-.05.06-.45,0-.65,0s-.3.12,0,.24c.3.12-.5-.12-.64-.06-.15.06-.4.18-.55.12-.15-.06.1-.12-.05-.24-.15-.12-.15.06-.4.12-.25.06-.99-.12-.99.06s0,.18-.59.12c-.6-.06-.99.06-1.24.24s-.69.3-.89.3-.74,0-.45.12c.3.12.94.06.84.18-.1.12-.4.18-.55.12-.15-.06-.74.06-.99.06s-.6-.06-.84,0c-.25.06-.45-.06-.35.12.1.18.3.18.25.36-.05.18-.2.18.2.24.4.06.79.06.79.18s-.25.12-.1.3c.15.18.25.3.2.36-.05.06-.25-.06-.25.12s-.1.3-.1.12.2-.36.05-.42c-.15-.06-.45.06-.3-.12.15-.18.55-.3.15-.36-.4-.06-.5.18-.64,0-.15-.18-.45-.3-.69-.3s-.4,0-.45.12c-.05.12-.2.06-.4,0-.2-.06-.7,0-.45.18.25.18.99.24.99.3s.05.3-.25.12c-.3-.18-.59-.18-.79-.18s-.3-.18-.2-.3c.1-.12.25-.3.1-.36-.15-.06-.4,0-.35.06.05.06.3.18-.05.24-.35.06-.65.12-.55.3.1.18.3.12.4.3.1.18-.15.18-.2.3-.05.12-.1.18-.05.36.05.18,0,.36.3.24.3-.12,1.19-.24,1.29,0,.1.24-.05.3-.05.42s-.05.61-.1.3c-.05-.3.05-.61-.15-.61s-.3-.18-.55-.06c-.25.12-.55-.18-.45.12.1.3.3.42.15.48-.15.06-.3.06-.35.18-.05.12-.15.18-.4.3-.25.12-.15.3-.4.18-.25-.12-.2-.12-.45-.12s.5-.06.55-.18c.05-.12.1-.36.25-.42.15-.06.2-.12.3-.24.1-.12.1-.24-.05-.24s-.4,0-.35-.18c.05-.18-.05-.36.05-.54.1-.18.15-.3.05-.42-.1-.12-.3-.06-.25-.18.05-.12.59-.36.4-.55-.2-.18-.65-.12-.65-.24s-.05-.24-.3-.24-.25.24-.35.3c-.1.06-.4,0-.5.24-.1.24-.25.42-.4.42s-.59.24-.5.36c.1.12.5.24.4.3-.1.06-.35.3-.2.36.15.06.45,0,.5.06.05.06.5.18.35.3-.15.12-.25.06-.25.24s-.15-.06-.35-.18c-.2-.12-.99-.24-1.19-.42-.2-.18-1.19-.12-1.34-.18-.15-.06-.64-.3-.69-.3s-.4-.18-.35.06c.05.24.3.3.5.36.2.06.65.24.5.3-.15.06-.35,0-.45.12-.1.12.15.3-.05.24-.2-.06-.25-.3-.3-.36-.05-.06-.59-.06-.64.06-.05.12-.79.12-.89.18-.1.06-.1.3-.25.18-.15-.12.1-.3.1-.36s-.35-.12-.54-.06c-.2.06-.4.06-.4.18s-.64,0-1.09.24c-.45.24-.35.18-.5.18s-.25.06-.3.24c-.05.18-.5.24-.6.18-.1-.06,0-.06-.2-.18-.2-.12.1-.36.35-.3.25.06.1-.3-.25-.36-.35-.06-.64.12-.79,0-.15-.12-.4-.12-.2.06.2.18.4.36.25.48-.15.12,0,.24.15.24s0,.24-.05.3c-.05.06-.1.18-.2.06-.1-.12-.05-.18-.2-.18s-.35,0-.65.18c-.3.18-.2,0-.4.12-.2.12-.4.06-.3.24.1.18.4.18.2.3-.2.12-.55.18-.65.06-.1-.12-.5-.3-.6-.24-.1.06-.4.18-.25.3.15.12.55-.06.6.12.05.18-.45.3-.6.18-.15-.12-.25-.24-.45-.24s-.25,0-.3-.24c-.05-.24.05-.18.05-.3s-.6-.42-.69-.55c-.1-.12.2,0,.55.06.35.06,1.89.48,2.48,0,.6-.49-.05-.55-.3-.67-.25-.12-1.64-.79-1.94-.73-.3.06-.59,0-.74-.12-.15-.12-.35-.18-.54-.12-.2.06-.5.12-.55.06-.05-.06.4-.12.25-.24-.15-.12-.3-.24-.54-.24s-.35-.18-.45-.18-.59,0-.65.12c-.05.12-.2.36-.25.24-.05-.12,0-.24-.25-.3-.25-.06-.65.06-.84.12-.2.06-.1.42-.45.3-.35-.12-.45-.24-.5-.18-.05.06-.15.24-.35.24s-.25-.24-.45-.12c-.2.12-.4.12-.65.24-.25.12-.6.24-.84.3-.25.06-.65.3-.79.42-.15.12,0,.18.3.12.3-.06,1.04-.06.74,0-.3.06-.89.3-.89.42s-.35.36-.54.61c-.2.24-.3.67-.55.73-.25.06-.55.3-.6.36-.05.06-.2,0-.35,0s-1.24.42-1.34.67c-.1.24-.4.42-.25.73.15.3.3.67.35.91.05.24-.1.36.25.48.35.12,1.09-.24,1.34-.42.25-.18.45-.54.5-.24.05.3.6.67.74,1.03.15.36-.1.42-.05.48.05.06,0,.24.15.36.15.12.4.18.5,0,.1-.18,0-.3.25-.3s.79-.24.84-.67c.05-.42-.05-.67.2-.67s.74-.36.65-.54c-.1-.18-.65-.12-.69-.42s.15-.67.3-.85c.15-.18,1.04-.61,1.19-.67.15-.06.35-.12.25-.3-.1-.18.1-.36.25-.42.15-.06,1.24-.18,1.14.06-.1.24-.55.36-.79.61-.25.24-.74.42-.79.61-.05.18.2.42.1.73-.1.3-.3.55.05.61.35.06.45.3.94.12.5-.18,1.39-.55,1.54-.42.15.12.65.18.79.3.15.12-.3-.06-.6.12s-1.34-.06-1.64.12c-.3.18-.4.36-.2.55.2.18.3.06.25.3-.05.24-.2.54-.54.3-.35-.24-.65-.24-.74.18-.1.42.35.79.15.91-.2.12-.65-.12-.65.06s-.05.36-.3.24c-.25-.12.05-.3-.35-.3s-.5.36-1.14.36-.89-.24-1.04-.18c-.15.06-.4.42-.65.24-.25-.18-.15-.24.05-.3.2-.06.65-.06.55-.18-.1-.12,0-.3-.15-.36-.15-.06-.15,0-.4.06-.25.06-.35.61-.4.3s.2-.42.25-.55c.05-.12-.05,0-.1-.24-.05-.24.2-.42,0-.54-.2-.12-.35.36-.55.36s-.54-.12-.5.18.15.42.25.67c.1.24-.2.3-.05.48.15.18.2.48-.05.36-.25-.12-.45-.18-.5-.06-.05.12-.4.06-.59.12-.2.06-.35.06-.35.18s-.25.67-.5.79c-.25.12-.74.12-.74.24s.15.49-.05.49-.55-.06-.55.18-.3.12-.45.06c-.15-.06-.15-.3-.25-.18-.1.12-.25.06-.1.24.15.18.4.3.15.3s-.4.06-.54-.06c-.15-.12-.3.06-.45.06s-.4-.12-.35.06c.05.18.2.18.15.3-.05.12.05.18.35.18s.65-.06.6.12c-.05.18-.15.12,0,.3.15.18.3.18.35.3.05.12.15.67,0,.91-.15.24-.1.42-.45.36-.35-.06-1.54,0-1.74-.06-.2-.06-.25-.18-.4-.12-.15.06-.1.18-.25.18s-.3-.12-.35.06c-.05.18.2.42.2.49s.15.24.1.36c-.05.12,0,.06-.05.3-.05.24.05.3-.1.49-.15.18-.45.3-.3.48.15.18.4.12.35.3-.05.18-.2.55,0,.61.2.06.35.12.5,0,.15-.12.25-.18.35.06.1.24.1.36.3.42.2.06.6-.3.74-.3s.74.06.84-.06c.1-.12.2-.36.3-.36s.15,0,.2-.18c.05-.18.2-.3.3-.3s0-.18-.05-.24c-.05-.06-.05-.24-.05-.24,0,0,.15-.36.25-.42.1-.06.15-.18.2-.24.05-.06.25-.06.4-.12.15-.06.4-.12.45-.24.05-.12.15-.3.05-.36-.1-.06-.1-.24-.05-.3.05-.06.3-.06.35-.12.05-.06.25-.12.3-.06.05.06.25.12.4.18.15.06.25,0,.4-.12.15-.12.3-.18.4-.18s.25-.18.35-.24c.1-.06.1-.12.25-.06.15.06.35.06.4.24s.3.61.4.67c.1.06.15.12.45.36.3.24.5.18.54.24.05.06.05.24.2.3.15.06.2-.06.25.06.05.12-.1.18.05.24.15.06.2-.24.3,0,.1.24.15.42.15.48s0,.12-.1.18c-.1.06-.05.18-.15.18s-.35.06-.4.06-.2.06-.25,0c-.05-.06-.15-.12-.3-.12s-.35.06-.3.18c.05.12.15.18.3.24.15.06.3.18.4.18s.15-.06.2.06c.05.12.2.24.25.12.05-.12.05-.24.05-.36s-.05-.18.1-.18.2.06.25-.06c.05-.12.05-.18.15-.3.1-.12.2-.06.25-.12.05-.06.1-.24.05-.3-.05-.06-.2,0-.25-.12-.05-.12-.05-.24.05-.3.1-.06.35.24.5.24s.3,0,.2-.18c-.1-.18-.25-.3-.3-.3s-.45-.18-.5-.24c-.05-.06-.25-.06-.2-.12.05-.06.1-.12-.05-.18-.15-.06-.5,0-.54-.12-.05-.12-.15-.36-.25-.55-.1-.18-.2-.18-.35-.3-.15-.12-.4-.18-.35-.24.05-.06.15-.06.15-.18s-.1-.24,0-.3c.1-.06.5-.3.45-.12-.05.18-.15.12,0,.3.15.18.15-.06.25,0,.1.06.05.18.25.42.2.24.4.24.5.36.1.12.4.24.45.24s.5.24.6.36c.1.12.15.18.25.24.1.06-.05.12-.05.3s-.05.42.05.48c.1.06.1.12.2.24.1.12.35.42.3.48-.05.06.15.24.2.3.05.06,0,.06.05.18.05.12.15.42.25.42s.05-.12.25.06c.2.18.4,0,.3-.18-.1-.18-.1-.24,0-.3.1-.06.35.06.35-.06s.15-.18.25,0c.1.18,0-.12-.05-.24-.05-.12-.4-.3-.54-.48s-.25-.48-.25-.55.1-.18.15-.06.25.3.3.18c.05-.12.15-.42.25-.36.1.06.4-.06.55,0,.15.06.2.18.15.3-.05.12-.15.18-.1.3.05.12.3.06.3.24s-.3,0-.2.3c.1.3.2.3.35.42.15.12.55.61.69.55.15-.06.15.24.35.18.2-.06.35-.12.4-.24.05-.12.2-.12.35,0,.15.12.4.36.55.3.15-.06.4-.18.5-.24.1-.06.15-.36.3-.18.15.18.35,0,.45.06.1.06-.2.12-.15.3.05.18.15.61.05.79-.1.18-.3.36-.3.61s-.2.79-.35.85c-.15.06-.69.06-1.19-.06-.5-.12-.5.36-.84.3-.35-.06-.54-.18-.89-.24-.35-.06-.45-.06-.55-.06s-.05-.12-.2-.18c-.15-.06-.45.06-.5-.06-.05-.12-.15-.06-.25-.18-.1-.12-.15-.12-.4-.18-.25-.06-.84.12-.84.3s.2.49.1.61c-.1.12-.25.3-.4.3s-.79-.42-1.29-.48c-.5-.06.05-.42-.45-.61-.5-.18-.94-.06-1.09-.18-.15-.12-.3-.18-.4-.3-.1-.12-.3-.06-.35-.18-.05-.12.2-.18.25-.36.05-.18.15-.42-.05-.61-.2-.18.1-.18.15-.36.05-.18-.1-.18-.25-.12-.15.06.1-.18-.15-.24-.25-.06-.5.18-.65.18s-.79-.18-.99.06c-.2.24-.1.24-.35.12-.25-.12-.79-.06-.99.06s-.35-.12-.65,0c-.3.12-.3.36-.5.42-.2.06-.2-.06-.45.12-.25.18-.59.24-.79.12-.2-.12-.45.12-.55,0-.1-.12-.2-.48-.3-.36-.1.12-.2.24-.3.55-.1.3-.2.42-.45.48-.25.06-.94.42-.84.61.1.18-.05.3-.1.55-.05.24.1.3.05.48-.05.18-.25.73-.5.79-.25.06.05.3-.3.36-.35.06-.5-.12-.59.06-.1.18,0,.42-.15.55-.15.12-.25.3-.45.85-.2.54-.05.18-.3.42-.25.24-.25.61-.4.85-.15.24-.45.49-.25.73.2.24.3.42.3.42,0,0-.1.3,0,.55.1.24.05.55-.05.85-.1.3,0,.54-.05.73-.05.18-.2.42-.3.48-.1.06.1-.06.2.24.1.3,0,.48,0,.67s.15.48.3.55c.15.06.79.61.94.91q.15.3.2.73c.05.42-.1.42.3.55.4.12,1.19.91,1.44,1.15.25.24.35.42.65.24.3-.18,1.24-.54,1.89-.3.65.24.74-.3,1.29-.42.55-.12.89-.24,1.24-.24s.35.06.5.48c.15.42.35.67.69.55.35-.12.79-.06.94.06.15.12.3.06.2.42-.1.36-.2,1.15-.25,1.39-.05.24-.3.42-.2.73s.55,1.09.84,1.33c.3.24.6.91.6,1.15s.3.61.35.97c.05.36-.2.12-.1.55.1.42.45.54.25.97-.2.42.15.24-.2.61-.35.36-.3.49-.35.91-.05.42-.25.54-.2,1.09.05.55-.05.61.15.91.2.3.54,1.03.84,1.58.3.55.05.61.05.85s.15.36.2.67c.05.3,0,.67.05.97.05.3.45.61.55.79.1.18.15.36.35.79.2.42.5.61.45.91-.05.3-.2.06-.25.36-.05.3.25.06.3.36.05.3.05.48.2.42.15-.06.2.24.45.18.25-.06.3-.18.3-.18Z");
    			attr(path84, "d", "m141.65,9.08s.3,0,.35-.13c.05-.13.1-.19,0-.25s-.2-.06-.15-.13c.05-.06.2,0,.25-.06.05-.06.25-.25.25-.13s-.2.19-.1.26c.1.06.15.13.15.19s.15,0,.25,0,.3-.13.45-.06c.15.06.4.19.35.25-.05.06.05.13.15.13s.3-.06.45.06c.15.13.45.25.55.19.1-.06.2-.25.25-.32.05-.06.1-.19,0-.26-.1-.06-.25-.06-.2-.13.05-.06.35.13.5.13s.15-.13.4-.19c.25-.06.45-.13.3-.19-.15-.06-.65-.32-.69-.38-.05-.06-1.14-.13-1.14-.06s.25.13.15.25c-.1.13-.3.13-.3,0s.05-.32,0-.38c-.05-.06-.35-.25-.65-.32-.3-.06-.45-.06-.55-.19-.1-.13-.35-.13-.45-.19-.1-.06-.4-.13-.45-.13h-.1v2.03Z");
    			attr(path85, "d", "m67.69,15.33s.15-.18.2-.3c.05-.12-.1-.24-.1-.3s-.05-.18,0-.24c.05-.06.1-.06.1-.12s.2-.12.2-.12c0,0,.05-.12-.05-.18-.1-.06-.05-.18-.15-.24-.1-.06-.15,0-.25,0s-.25-.06-.35-.06-.2.06-.3.06-.2.06-.2.18.2.06.15.12c-.05.06-.15.12-.3.12s-.35-.18-.4-.06c-.05.12-.05.3,0,.3s-.05,0-.05.12-.05.12.1.12.35,0,.35.06-.1,0-.15.12q-.05.12-.15.18c-.1.06-.15.12-.2.12s-.1.06-.05.12c.05.06.1.06.1.18s0,.06.15.12c.15.06.4,0,.5-.06.1-.06.35-.24.45-.24h.4Z");
    			attr(path86, "d", "m68.78,16.24s.15-.3.3-.24c.15.06.2.06.3.06s.1-.06.2-.06.2.12.25.06c.05-.06.2-.18.25-.12.05.06.15.12.3.06.15-.06.35-.18.4-.18s.15-.18.05-.18-.45,0-.4,0,.2-.12.3-.18c.1-.06.25-.18.25-.24s-.05-.3-.15-.3-.5.12-.5.06.1-.12.1-.18-.05,0-.1-.12c-.05-.12-.15-.3-.15-.36s-.05-.18-.15-.18-.35-.06-.35-.18-.15-.24-.15-.3-.25-.24-.35-.24-.35.12,0-.18c.35-.3.35-.55.35-.55,0,0-.3-.12-.45-.06-.15.06-.25.12-.35,0-.1-.12-.05-.18.1-.24.15-.06.2-.06.2-.12s.25-.12.2-.24c-.05-.12,0,0-.05-.18-.05-.18-.35.06-.3.12.05.06.05.18-.05.18s-.5.06-.54,0c-.05-.06-.05.12-.1.18-.05.06-.15.3-.2.24-.05-.06-.05,0-.05.12s-.05.18-.1.06-.15-.18-.15-.12-.15.18-.05.24c.1.06.3.18.25.18s-.25.12-.15.18c.1.06.1.12.15.12s0,.12-.1.12-.2,0-.1.12c.1.12.1.18.2.06.1-.12,0,.06.1.12q.1.06.15-.06c.05-.12.2-.18.2-.06s-.2.24-.15.3q.05.06.15.12c.1.06.1.12.2.06.1-.06.15-.18.25-.12.1.06-.05.06.05.18.1.12.2.18.25.18s-.05-.06-.05.12-.15.3-.25.24c-.1-.06-.25-.12-.3-.06-.05.06,0,.06-.05.18-.05.12-.15,0-.1.12.05.12.1.06.2.06s.05.12-.05.18c-.1.06-.3,0-.3.12s-.1.24.05.24.15-.12.25-.06c.1.06.15.18.25.12.1-.06.2.06.3,0,.1-.06.15.12-.05.12s-.25,0-.4.06c-.15.06-.3.24-.35.24s-.1.24-.25.18c-.15-.06,0,.18.15.12.15-.06.2-.18.3-.18s.3.12.35.06Z");
    			attr(path87, "d", "m78.36,2.59s.1,0,.15.12c.05.12.25,0,.25.06s-.1.12-.2.18c-.1.06-.05.18.05.12.1-.06.35-.12.45-.12s.1,0,.15.12c.05.12.15.12.25.06.1-.06.4-.12.45-.18.05-.06,0-.18-.1-.18s-.3.06-.3,0,0-.18-.1-.18-.25.12-.3.06c-.05-.06-.1-.18-.2-.18s0,.06-.1-.06-.3-.18-.35-.18-.15-.06-.25-.06-.2.06-.3,0c-.1-.06-.15,0-.15-.12s-.3.06-.4,0c-.1-.06.05-.18-.05-.18s-.5,0-.55-.06c-.05-.06-.25-.06-.3.06-.05.12.15.3.2.36.05.06-.15,0-.4-.18-.25-.18-.2-.18-.35-.12-.15.06-.2.12-.3.06-.1-.06,0-.12-.15-.12h-.55c-.1,0-.15.12-.25.06-.1-.06-.15-.18-.15-.06s-.05.24.05.3c.1.06.2.06.3.06s-.25.12-.1.18q.15.06.3.12c.15.06.25.12.4.12s.3,0,.4-.06c.1-.06.1-.18.25-.12.15.06.3.18.4.12.1-.06-.1.12-.25.12s-.55-.12-.6,0c-.05.12,0,.18.15.18s.35-.12.5-.06c.15.06,0,.18-.2.18s-.45-.12-.35,0c.1.12.2.18.4.18s.15-.06.35.12c.2.18.35.3.4.18.05-.12.2-.36.3-.42.1-.06.35.06.35-.06s0-.24.1-.24.2-.06.2-.12.05-.12.15-.12.3-.06.3-.06c0,0,.1,0,.05.12Z");
    			attr(path88, "d", "m74.34,2.41s.1-.12.2-.12.1.18.25.24c.15.06.4.12.25.12s-.3-.06-.45-.12c-.15-.06-.3-.06-.25-.12");
    			attr(path89, "d", "m78.26,1.56s.25.12.4.12.15,0,.3.06c.15.06.1.06.15,0,.05-.06.05-.24.15-.18.1.06.2.06.25.12.05.06.1-.06.2-.06s.35,0,.55.06c.2.06.45-.12.54,0,.1.12.2,0,.15.12-.05.12-.15.18-.35.24-.2.06-.6.06-.69.12-.1.06-.15.06-.25.06s-.4,0-.45-.06c-.05-.06-.15-.06-.3-.06s-.35.12-.5,0c-.15-.12-.35,0-.35-.06s-.1-.12-.25-.12-.35,0-.35-.06,0-.12.15-.18c.15-.06.25-.06.3-.12.05-.06.2-.12.35,0Z");
    			attr(path90, "d", "m89.48,6.9s.4-.06.54.06c.15.12.25.12.15.18-.1.06-.2.18-.35.18s-.4.06-.45-.06c-.05-.12-.05-.36.1-.36Z");
    			attr(path91, "d", "m94.73,3.56s.79.06,1.24-.06c.45-.12.5-.18.79-.24.3-.06.79.06.84.12.05.06-.45.36-.65.36s-.94.06-1.19.12c-.25.06-.79.18-.99.18s-.45.06-.5.18c-.05.12-.4.24-.5.18-.1-.06-.25.24-.45.3-.2.06-.3.18-.45.24-.15.06-.35.18-.45.3s-.25.3-.2.42c.05.12.25.36.45.42.2.06.5.12.4.18-.1.06-.4.06-.6.06s-.55.12-.69,0c-.15-.12-.15-.18-.25-.24-.1-.06-.2,0-.25.06-.05.06-.05,0-.2-.06-.15-.06-.2-.12-.35-.18-.15-.06-.25-.24-.1-.3.15-.06.25,0,.35-.06.1-.06.05-.12.05-.24s.05-.06.2-.12c.15-.06.1-.18.3-.12.2.06.25-.18.2-.18s-.35.06-.25-.06c.1-.12.1,0,.3-.12.2-.12.4-.18.45-.3.05-.12,0-.24.2-.24s.35.06.45-.06c.1-.12.2-.12.4-.18.2-.06.05-.06.3-.12.25-.06.4.06.45-.06.05-.12,0-.3.15-.18.15.12.25.18.35.12.1-.06.1-.12.2-.12Z");
    			attr(path92, "d", "m88.13,1.5s.3,0,.55-.06c.25-.06.4-.12.4-.06s-.1.12-.3.18c-.2.06-.74-.06-.65-.06Z");
    			attr(path93, "d", "m88.83,1.62s.2.06.3,0c.1-.06-.05-.12.2-.12s.35,0,.4-.06q.05-.06.15-.06h.45c.25,0,.5-.12.4,0-.1.12-.3.12-.45.18-.15.06-.45-.12-.3.06.15.18.25.12.35.12s.45,0,.25.06c-.2.06-.45.12-.65,0-.2-.12-.1-.18-.35-.06-.25.12-.15.06-.35.06s-.25.06-.35,0c-.1-.06-.2-.18-.05-.18Z");
    			attr(path94, "d", "m91.06,1.62s.15-.06.3,0c.15.06.4,0,.25.06q-.15.06-.35.06c-.2,0-.4-.12-.2-.12Z");
    			attr(path95, "d", "m91.76,1.38s-.05-.12.2-.12.3,0,.45-.06c.15-.06.25-.18.35-.12.1.06.25-.06.45,0,.2.06.5.18.35.3-.15.12-.1.12-.3.06-.2-.06-.25.06-.45.06h-.84c-.1,0-.2-.06-.2-.12Z");
    			attr(path96, "d", "m92.45,1.68s-.05-.06.15-.06.25.06.35,0c.1-.06.3-.12.4-.06.1.06.3-.12.25,0-.05.12-.05.06-.25.12-.2.06-.25.18-.35.12-.1-.06-.05,0-.3,0s-.25-.12-.25-.12Z");
    			attr(path97, "d", "m93.84,1.56c-.05-.06-.05-.24.05-.18.1.06.2.06.3.06s.3-.06.4-.06.5-.12.35,0c-.15.12-.2.06-.3.18-.1.12-.1.18-.25.12-.15-.06-.1-.06-.2-.06s-.2.06-.25.06-.1-.12-.1-.12Z");
    			attr(path98, "d", "m95.08,1.38s.35-.06.5-.06.05,0,.15-.06c.1-.06.3-.18.35-.06.05.12.05.24-.1.24s-.2,0-.35.06c-.15.06-.25,0-.35,0s-.3-.06-.2-.12Z");
    			attr(path99, "d", "m93.25.95s.1-.06.2-.06.3-.06.25,0c-.05.06-.15.12-.2.12s-.25-.06-.25-.06Z");
    			attr(path100, "d", "m94.93.95s.3-.06.4,0c.1.06.2.12-.05.12s-.45-.12-.35-.12Z");
    			attr(path101, "d", "m105.95,1.26s.15-.06.3-.06.4.12.2.12-.59,0-.5-.06Z");
    			attr(path102, "d", "m107.34,1.26s.6.06.65,0c.05-.06.15-.24.2-.12.05.12.4.24.55.24s.4,0,.3.06c-.1.06-.35.12-.25.18.1.06-.25.06-.45.06s-.5.06-.65.12c-.15.06-.25.06-.4.12-.15.06-.3.12-.4.06-.1-.06-.1-.12-.2-.06-.1.06-.25.06-.3,0-.05-.06,0-.18.15-.18s.45,0,.35-.06c-.1-.06-.3-.12-.2-.12s.3.06.4-.06c.1-.12.15-.24.25-.24Z");
    			attr(path103, "d", "m107.64,1.92s.15-.18.79-.18.89,0,.74.06c-.15.06.1.06.2,0,.1-.06.25-.18.35-.06.1.12.35,0,.25.12-.1.12-.35.24-.2.3.15.06.3.06.2.12-.1.06-.45.12-.74.06-.3-.06-.1-.06-.4-.06s-.54.06-.65,0c-.1-.06-.15,0-.35-.06-.2-.06-.1-.06-.2-.12-.1-.06-.35-.18,0-.18Z");
    			attr(path104, "d", "m109.87,2.59s.15-.24.3-.24.05-.06.2-.12c.15-.06.2-.24.4-.18.2.06.3-.12.35,0,.05.12-.3.12-.1.18.2.06.2-.12.35-.06.15.06.3.12.3.12,0,0,.45-.12.45.06s-.05.24-.3.24-.79,0-.99.06c-.2.06-.25,0-.45.06-.2.06-.5.06-.55.06s-.3,0,.05-.18Z");
    			attr(path105, "d", "m124.01,3.99s.05-.12.05-.18.1-.06.15,0c.05.06.2.12.1.18-.1.06-.1.12-.2.06-.1-.06-.15.06-.1-.06Z");
    			attr(path106, "d", "m124.01,4.59s.15,0,.2.06c.05.06.3.12.15.12s-.15,0-.25-.06c-.1-.06-.25-.12-.1-.12Z");
    			attr(path107, "d", "m124.85,3.74s.2,0,.3-.06c.1-.06.35-.12.45,0,.1.12.4.3.5.24.1-.06,0-.12.15-.18.15-.06.4-.18.54-.06.15.12.25.12.45.12s.45-.06.55.06c.1.12.25,0,.15.12-.1.12-.15.18-.3.24-.15.06-.25.06-.35.06s-.45.12-.55.06c-.1-.06-.15-.18-.25-.12-.1.06-.69.12-.74.06-.05-.06.05,0-.15.06q-.2.06-.45,0c-.25-.06-.35,0-.5-.12s0-.42.2-.48Z");
    			attr(path108, "d", "m128.33,3.93s.1,0,.2.06c.1.06.1,0,.2,0s.4,0,.54.06c.15.06.15,0,.35,0s.74-.06.59.06c-.15.12-.4.24-.59.24s-.6-.06-.69-.06-.05,0-.35-.06c-.3-.06-.45-.12-.25-.3Z");
    			attr(path109, "d", "m125.85,4.53s.45,0,.45.06-.15.18-.3.12c-.15-.06-.35-.12-.15-.18Z");
    			attr(path110, "d", "m126.04,4.9s.25-.18.3-.18.45-.06.5,0c.05.06.35.18.35.24s.05.18-.1.18-.35-.06-.55-.06-.3-.06-.45-.06h-.4s-.05-.06.35-.12Z");
    			attr(path111, "d", "m101.98,35.83s.3,0,.35.24c.05.24.2.54.3.67.1.12.2.61.05.73-.15.12-.3.36-.45.3-.15-.06-.3-.18-.3-.42s-.15-.79-.05-.91c.1-.12.15-.12.15-.3s-.35-.12-.05-.3Z");
    			attr(path112, "d", "m107.14,33.95s-.05.24-.1.3c-.05.06-.1.06-.05.18.05.12.1.24,0,.3-.1.06-.1.18-.05.24.05.06.15.24.15.12s.05-.3.05-.42-.05-.12,0-.24c.05-.12.15-.55,0-.49Z");
    			attr(path113, "d", "m106.84,35.41s.05.12.1.12.15,0,.1-.12c-.05-.12,0-.12-.1-.12s-.15.06-.1.12Z");
    			attr(path114, "d", "m107.39,37.17s.1.36.15.24c.05-.12.1-.18.05-.3s-.15-.18-.2-.12c-.05.06,0,.18,0,.18Z");
    			attr(path115, "d", "m107.29,36.8s.15,0,.15-.06,0-.24-.05-.24-.25.06-.2.12c.05.06.1.18.1.18Z");
    			attr(path116, "d", "m108.23,37.83s.05.18.35.18.45-.12.5.06c.05.18.25.67.4.73.15.06.6.36.65.55.05.18.2.18.3.18s.3.3.4.36c.1.06.15,0,.2.12.05.12.25.24.2.3-.05.06.2-.06.2.12s-.15.42-.15.49.35,0,.4.18c.05.18-.1.24.05.36q.15.12.25.24c.1.12.2-.06.25.12.05.18.2.18.15.36-.05.18-.15.79-.1.97.05.18.15.48-.05.3-.2-.18-.2-.36-.3-.24-.1.12-.05.36-.2.24-.15-.12-.45-.61-.7-.79-.25-.18-.45-.55-.55-.79-.1-.24-.45-1.09-.6-1.21-.15-.12-.3-.06-.3-.24s0-.67-.1-.73c-.1-.06-.3-.24-.4-.24s0-.24-.1-.3c-.1-.06-.3-.42-.4-.42s-.25,0-.25-.12-.2-.3-.25-.42c-.05-.12-.15-.24-.1-.3.05-.06.2-.18.25-.06Z");
    			attr(path117, "d", "m108.18,39.17s-.05.12.05.18c.1.06.2.06.25.12.05.06.1.18.1.06s-.1-.36-.2-.36-.15-.12-.2,0Z");
    			attr(path118, "d", "m108.88,39.84s.15,0,.15.12.2.12.15.18c-.05.06,0,.3-.1.24-.1-.06-.1-.18-.15-.24-.05-.06-.15-.06-.15-.12s.05-.24.1-.18Z");
    			attr(path119, "d", "m109.22,40.63s.1.06.05.12c-.05.06-.1.12,0,.12s.2,0,.15-.12c-.05-.12-.1-.3-.15-.24-.05.06-.1.12-.05.12Z");
    			attr(path120, "d", "m109.37,41.05s.15-.06.15,0,.05.12.1.18c.05.06.15.18,0,.18s-.25-.06-.25-.12-.05-.24,0-.24Z");
    			attr(path121, "d", "m109.77,41.59s-.05.18.05.18.05-.06.05-.12-.1-.06-.1-.06Z");
    			attr(path122, "d", "m109.92,41.96s.1.06.1.12,0,.12.05.12.15,0,.1-.12c-.05-.12-.1-.06-.1-.18s-.05-.06-.1-.06-.1.12-.05.12Z");
    			attr(path123, "d", "m111.95,41.47s.1-.06.1-.12.2-.18.25-.06c.05.12-.05.3.05.36.1.06.2,0,.2.12s.05.3-.05.24c-.1-.06-.15-.06-.2-.18-.05-.12,0-.18-.15-.18s-.3-.12-.2-.18Z");
    			attr(path124, "d", "m112.85,41.96s.05-.18.1-.18.3-.12.3.06.05.3-.1.3-.3-.06-.3-.18Z");
    			attr(path125, "d", "m112.5,43.48s.35,0,.45.06c.1.06.25.06.3.18.05.12,0,.12.2.18.2.06.74.12.74,0s.05-.36.15-.24c.1.12.4.18.69.24.3.06.64-.06.5.06-.15.12-.55.06-.5.18.05.12.2.3.35.24.15-.06.4-.06.35.06-.05.12.05,0,.2.06.15.06.3,0,.25.12s.05.36-.15.3c-.2-.06-.25-.24-.3-.24s.05.18-.05.18-.35-.18-.4-.18-.25.06-.4.06-.64-.18-.84-.24c-.2-.06-.15-.12-.45-.12s-.69.12-.69,0-.15-.18-.3-.18-.2-.12-.2-.18-.1,0-.3-.06c-.2-.06-.05-.12.05-.18.1-.06.3-.3.35-.3Z");
    			attr(path126, "d", "m116.32,44.69s.15-.18.2-.12c.05.06,0,.06,0,.18s.05.3-.1.24c-.15-.06-.15-.18-.1-.3Z");
    			attr(path127, "d", "m116.67,44.69s.1-.06.2-.12c.1-.06.2-.12.4,0,.2.12.4.06.3.18-.1.12-.2.12-.35.12s-.25.24-.35.18c-.1-.06-.3,0-.2-.36Z");
    			attr(path128, "d", "m117.86,44.63s.1-.18.25-.06c.15.12.15.06.3.12.15.06.35.06.4,0,.05-.06.15-.24.35-.18.2.06.55.06.65.06s.15,0-.05.06c-.2.06-.5-.06-.65.06-.15.12-.59.3-.74.24-.15-.06-.25-.06-.4-.06s-.2-.18-.1-.24Z");
    			attr(path129, "d", "m117.46,45.11s.4-.06.45,0c.05.06.1.06.2.18.1.12.1.36-.05.3-.15-.06-.2-.24-.35-.24s-.4-.24-.25-.24Z");
    			attr(path130, "d", "m119.3,45.17s.25.12.35-.06c.1-.18.25-.3.3-.3s.7-.06.74-.12c.05-.06,0,.12-.1.18-.1.06-.6.12-.74.42-.15.3-.3.3-.4.3s-.3.12-.3,0,.2-.24.15-.42Z");
    			attr(path131, "d", "m115.13,38.99s.54-.85.69-.79c.15.06.25.06.25,0s-.1-.3.05-.36c.15-.06.2-.12.25-.3.05-.18.3-.3.3-.3,0,0,.3,0,.3.18s-.1.24.05.3c.15.06.2.12.35.18.15.06.3,0,.2.12-.1.12-.45.12-.4.24.05.12.35.18.2.24-.15.06-.35-.06-.4.12-.05.18-.15.12-.15.3s.35.3.3.48c-.05.18-.05.3,0,.36.05.06.3.3.3.36s-.35-.06-.4.06c-.05.12-.1.48-.1.67s-.15.12-.25.3c-.1.18-.1.24-.1.42s-.15.24-.15.36.1.3.05.42c-.05.12-.2.3-.2.12s-.25-.06-.4.06c-.15.12-.15-.06-.15-.18s-.3-.18-.35-.12c-.05.06-.05-.06-.1-.12-.05-.06-.2.24-.35.18-.15-.06-.2-.06-.3,0-.1.06-.05-.18-.05-.24s-.5.06-.5-.06-.2.3-.2-.18.05-.67-.1-.67-.2,0-.2-.12.1-.42-.05-.55c-.15-.12-.2-.12-.15-.36.05-.24.15-.61.3-.54.15.06,0,.12.25.18.25.06.35.12.35,0s.05-.42.15-.48c.1-.06.6-.06.69-.3Z");
    			attr(path132, "d", "m117.66,40.99s-.15.24-.1.42c.05.18-.15.36-.2.48-.05.12-.15.3.05.36.2.06.2-.06.25.06.05.12.05.42,0,.55-.05.12-.1.18-.05.3.05.12.05.24.2.18.15-.06.25.06.25-.12s.05-.67,0-.79c-.05-.12.05-.12-.05-.24-.1-.12-.15-.18.05-.24.2-.06.25,0,.2.12-.05.12-.05.18.05.3.1.12.25.12.2.24-.05.12-.2.12-.1.24.1.12.25,0,.2.12-.05.12-.1.48,0,.3.1-.18.1-.36.15-.24.05.12.1.3.2.24.1-.06.15-.06.15-.18s-.15-.18-.1-.24c.05-.06.1-.12,0-.24s-.15-.18-.15-.3-.15-.48-.25-.61q-.1-.12-.05-.18c.05-.06.15-.06.25-.18.1-.12.15-.3.2-.24.05.06-.05.18.1.24.15.06.25.06.2-.06q-.05-.12-.05-.24c0-.12.05-.24-.15-.24s-.25.3-.4.24c-.15-.06-.05-.12-.2-.06-.15.06-.15.18-.2.24-.05.06-.05,0-.2-.12-.15-.12-.2-.24-.2-.36s-.05-.42.15-.36c.2.06.55.06.69,0s.25-.12.4,0c.15.12.2.12.35.06.15-.06.25-.12.3-.3.05-.18.1-.36.05-.42-.05-.06-.2.18-.3.3-.1.12-.45.06-.55.06s-.25-.06-.4-.06-.15-.12-.25-.12-.1,0-.25.12c-.15.12-.2.06-.25.18-.05.12-.05.24-.1.36-.05.12,0,.36-.1.42Z");
    			attr(path133, "d", "m119.54,41.41s.25-.06.4,0c.15.06.45.06.35.12-.1.06-.35-.06-.5,0-.15.06-.35-.06-.25-.12");
    			attr(path134, "d", "m120.29,42.08h.25c.15,0,.2.12.2.18s-.1.36-.25.18c-.15-.18-.3-.3-.2-.36Z");
    			attr(path135, "d", "m113.54,31.04s-.2.12-.2.18-.05.36.05.42c.1.06.2.18.35.12.15-.06.35-.3.4-.36q.05-.06.15-.24c.1-.18.1-.42,0-.36-.1.06-.35.06-.45.06s-.3.18-.3.18Z");
    			attr(path136, "d", "m117.36,35.65s-.1.24-.2.3c-.1.06-.45.42-.45.48s.1.06.15.06.3-.3.4-.42c.1-.12.2-.24.25-.3.05-.06.35-.18.35-.24s-.05-.06-.1-.18c-.05-.12,0-.12.05-.24s.2-.18.2-.3-.05-.06-.1-.18c-.05-.12-.15-.12-.15,0s0,.42-.1.48c-.1.06-.1.24-.15.36-.05.12-.15.18-.15.18Z");
    			attr(path137, "d", "m118.35,37.59s-.15,0-.2.06c-.05.06,0,.18-.05.24-.05.06,0,.24.05.12.05-.12,0-.18.15-.18s.1-.18.05-.24Z");
    			attr(path138, "d", "m116.67,36.74c-.05.06-.05.12,0,.12s.1-.12.1-.12h-.1Z");
    			attr(path139, "d", "m118.1,31.65s-.2.18-.15.3c.05.12.05.18.05.24s-.05.3-.05.42,0,.3-.05.18c-.05-.12-.15-.24-.15-.18v.3c0,.12.1.36.15.49.05.12.1.12.15.06.05-.06.1-.06.15,0,.05.06,0,.12-.05.12s-.1.06-.05.18.1.24.2.24.15-.12.25-.12.2,0,.25.12c.05.12.05.24.1.12.05-.12.05-.24.15-.06.1.18.25.18.3.3.05.12.15.24.15.12s-.05-.3-.1-.36q-.05-.06.1-.06c.15,0,.2-.3.1-.3s-.2.12-.3.06c-.1-.06-.35-.24-.35-.24,0,0-.1.06-.15.12-.05.06-.2.06-.25-.06s0-.12,0-.18,0-.06-.05-.24c-.05-.18.05-.12.05-.24s.25-.3.25-.42.15-.24.05-.36c-.1-.12-.15-.18-.1-.3.05-.12.15-.3.05-.3s-.15.18-.25.06c-.1-.12-.05-.12-.2-.12s-.2.06-.25.12Z");
    			attr(path140, "d", "m118.06,34.19s.15.18.15.24,0,.24.1.24.2,0,.2-.18-.05-.36-.15-.42c-.1-.06-.25,0-.3,0s0,.12,0,.12Z");
    			attr(path141, "d", "m119.64,34.68s.15,0,.15.12.05.24-.05.24-.05-.18-.1-.12c-.05.06-.1.12-.05.24.05.12.15.12.15.18s-.05.18-.05.24.1.18.15.12c.05-.06.2,0,.1-.18-.1-.18-.1-.24-.05-.3.05-.06.2.12.2,0s-.15-.24-.1-.3c.05-.06.05-.18,0-.3-.05-.12-.1-.06-.2-.12-.1-.06-.2,0-.2.06s0,.12.05.12Z");
    			attr(path142, "d", "m118.65,34.86s.05.42,0,.55c-.05.12,0,.18.05.12.05-.06.15,0,.2-.06.05-.06,0-.18.05-.18s.15,0,.15-.12,0-.06-.1-.18-.2,0-.25-.06c-.05-.06-.05-.18-.1-.06Z");
    			attr(path143, "d", "m119,35.41s-.05.18-.05.24-.15.06-.15.12,0,.12.05.18c.05.06.15.12.15.18s.15.24.15.06.05-.24.1-.24.1-.18.05-.24c-.05-.06-.1-.06-.05-.18q.05-.12,0-.18c-.05-.06-.05,0-.15,0s-.1,0-.1.06Z");
    			attr(path144, "d", "m119.45,35.77s-.1-.06-.05.06c.05.12.1.12.15.12s.15-.06.15-.12.05-.18-.05-.18-.1,0-.15.06l-.05.06Z");
    			attr(path145, "d", "m119.45,37.17s0,.36.05.42c.05.06.3.12.4.18.1.06.2.12.25,0,.05-.12,0-.18-.05-.3-.05-.12-.05-.24,0-.24s.05.06.1.12c.05.06.15.36.15.18s-.05-.24,0-.3c.05-.06.15-.06.15-.12s-.05-.36-.05-.42-.1-.06-.1-.18v-.18c0-.06-.05-.3-.1-.3s-.15,0-.15-.06-.1-.18-.1-.06.1.3.05.3-.2.06-.2,0-.1-.12-.15-.06c-.05.06.1.3,0,.3s-.2-.06-.2.06,0,.24-.05.18c-.05-.06-.05-.18-.1-.24-.05-.06-.15-.06-.2,0q-.05.06-.15.12c-.1.06-.15-.06-.2.06-.05.12-.05.24-.1.3-.05.06-.1.12-.1.18s.05.12,0,.18c-.05.06-.15.12-.05.18.1.06.3.12.25,0-.05-.12-.1-.18-.05-.24.05-.06.05-.18.1-.24.05-.06.1-.24.1-.12s0,.3.05.24c.05-.06.1-.06.1-.12s.05,0,.1-.06c.05-.06.1-.12.15-.06.05.06.1.12.15.12s0,.18-.05.18Z");
    			attr(path146, "d", "m118.1,28.74s-.2.48-.2.55,0,.24.1.36c.1.12.1.36.15.3.05-.06,0-.12.1-.24.1-.12.15-.42.2-.54.05-.12.05-.24.1-.3.05-.06.1-.36.1-.36,0,0-.05-.12-.15-.18-.1-.06-.35.3-.4.42Z");
    			attr(path147, "d", "m123.51,23.28s-.3.24-.45.12c-.15-.12-.35.24-.55.36-.2.12-.3-.06-.35.18-.05.24,0,.3-.2.3s-.25.06-.3.18c-.05.12-.05.36.05.3.1-.06.2-.06.2.12s-.2.3-.1.49c.1.18.15.3.3.24.15-.06.25-.18.3-.36.05-.18.2-.18.15-.42q-.05-.24-.1-.36c-.05-.12-.15-.42.05-.3.2.12.35-.06.3.18-.05.24-.1.36.05.42.15.06.15-.06.25-.18q.1-.12.3-.18c.2-.06.45-.06.25-.24-.2-.18-.5-.12-.45-.18.05-.06.55-.3.69-.18s0,.18,0,.3.15.42.3.24c.15-.18.3-.12.3-.3s-.1-.42,0-.36c.1.06.2.24.35.18.15-.06.3-.3.45-.24.15.06-.05.3.1.18.15-.12.25-.18.35-.18s.2-.12.25-.18c.05-.06,0-.36.1-.54.1-.18.2,0,.2-.24s-.05-.61.05-.61-.05-.12.1-.3c.15-.18.25-.18.2-.42-.05-.24-.2-.24-.2-.36s-.1-.24-.15-.36c-.05-.12-.1.12-.1.18s-.1-.24-.2-.12c-.1.12-.3.24-.25.36.05.12.1.61-.05.73-.15.12-.3.36-.35.48-.05.12-.25.42-.4.42s-.3.12-.3.06.05-.36-.05-.3c-.1.06-.15.24-.2.36-.05.12-.15.3-.2.42-.05.12-.1.24-.25.18-.15-.06-.3-.06-.45-.06Z");
    			attr(path148, "d", "m126.44,19.94l.65.3s-.05-.18.1-.3c.15-.12.2-.24.4-.18.2.06.3-.06.35-.12.05-.06-.15-.12-.15-.24s.25-.36.1-.3c-.15.06-.35.3-.55.12-.2-.18-.5-.36-.55-.48-.05-.12-.2-.24-.3-.18-.1.06,0,.24,0,.36s-.1.36-.15.48c-.05.12.2.36,0,.3-.2-.06-.25-.18-.35-.18s.05.06-.1.18q-.15.12-.2.24c-.05.12,0,.24.05.3.05.06-.1.12,0,.18.1.06.05.12.2,0s.45,0,.3-.12c-.15-.12-.35-.12-.3-.24.05-.12.05,0,.2,0s.25-.12.3-.12Z");
    			attr(path149, "d", "m126.64,16.3s0,.42-.05.48c-.05.06-.25.12-.1.24.15.12.15.06.15.18s-.1.12-.1.3.05.3,0,.36c-.05.06-.05.18,0,.3.05.12.1.36.15.12.05-.24,0-.42.1-.36.1.06.3,0,.3.12s.05.48.1.24c.05-.24,0-.36-.1-.55-.1-.18-.25-.12-.25-.3s.1-.12.1-.3.15-.42.15-.42c0,0,.25-.12.35,0,.1.12.35.48.25.24-.1-.24-.3-.67-.35-.79-.05-.12-.2-.61-.25-.67-.05-.06-.05-.12,0-.24.05-.12.1-.24.05-.36s-.1-.12-.1-.24.05-.12,0-.24q-.05-.12-.15-.18c-.1-.06-.3-.06-.2.06.1.12.25.18.15.24-.1.06-.1.3-.15.18-.05-.12-.15-.06-.15-.06,0,0-.1.06-.05.24.05.18.05.24,0,.3-.05.06-.05.3.05.42.1.12.1.24.1.3s-.05.24,0,.36Z");
    			attr(path150, "d", "m127.93,19.33s.1-.06.15-.18c.05-.12.15-.24.2-.18.05.06.2-.06.15.06-.05.12-.15.12-.2.18-.05.06-.05.12-.15.18-.1.06-.2,0-.15-.06Z");
    			attr(path151, "d", "m128.92,18.54s-.1.24-.2.24-.2.18-.2.18c0,0-.1.18,0,.12.1-.06.1-.12.25-.18.15-.06.2,0,.25-.12.05-.12.15-.06.25-.12.1-.06.1-.18.05-.18s0,0-.15.06c-.15.06-.2-.06-.25,0Z");
    			attr(path152, "d", "m129.52,18.36s.3-.12.35-.18c.05-.06.15-.06.1,0-.05.06-.05.18-.2.24-.15.06-.45,0-.25-.06Z");
    			attr(path153, "d", "m130.41,17.82s.05.06.15-.06.25-.24.25-.18.05.06-.1.18c-.15.12-.3.24-.35.12-.05-.12.05-.06.05-.06Z");
    			attr(path154, "d", "m132.2,15.94s-.1.12-.2.18c-.1.06-.2-.12-.2.06s0,.24.1.18c.1-.06.1-.12.2-.18.1-.06.15-.06.2-.12.05-.06,0-.18-.1-.12Z");
    			attr(path155, "d", "m131.65,16.54s-.05.06-.1.12c-.05.06-.15.18,0,.12.15-.06.25-.3.2-.3s-.1.06-.1.06Z");
    			attr(path156, "d", "m120.73,39.96s.2-.42.25-.42.05,0,.05.12.1.18,0,.3c-.1.12-.2.3-.25.18-.05-.12-.05-.18-.05-.18Z");
    			attr(path157, "d", "m121.13,39.53s.1.12.1.06.15-.06.1-.18c-.05-.12,0-.18-.1-.12-.1.06-.15.18-.1.24Z");
    			attr(path158, "d", "m121.18,39.84s-.1.18-.1.24-.15.12-.2.18c-.05.06-.1.06-.05.12s.1.06.1.24.05.24.1.3c.05.06.15.42.15.3s0-.24-.1-.42c-.1-.18-.05-.3-.05-.36s.1,0,.2,0,.05-.12,0-.18c-.05-.06,0-.12.05-.12s.05-.06.05-.18-.1-.18-.15-.12Z");
    			attr(path159, "d", "m120.73,40.75s-.1,0-.05.06c.05.06.1.12.15.18.05.06.1.18.1.06s0-.18-.05-.24c-.05-.06-.15-.06-.15-.06Z");
    			attr(path160, "d", "m120.78,41.29s-.05.06.05.12c.1.06.2,0,.25,0s.1.06,0-.06c-.1-.12-.05-.24-.15-.18-.1.06-.15.12-.15.12Z");
    			attr(path161, "d", "m121.03,42.02s-.1,0-.05.12c.05.12.1-.06.15,0,.05.06.05.12,0,.18-.05.06-.1.18,0,.12.1-.06.05-.24.2-.24s0,.06.15.06.2-.12.25-.06c.05.06.05.12.15.18.1.06.25.06.3.06s.1-.06,0-.18c-.1-.12-.1-.24-.2-.24s-.2,0-.25-.06c-.05-.06-.2,0-.3,0s-.15.06-.25,0c-.1-.06-.15.06-.15.06Z");
    			attr(path162, "d", "m121.78,41.41s-.2.06-.1.12c.1.06.15.18.25.06.1-.12.2-.12.1-.18-.1-.06-.25,0-.25,0Z");
    			attr(path163, "d", "m122.22,40.56h-.25c-.1,0-.35.06-.25.12.1.06.15.06.1.12-.05.06.05.18.15.12.1-.06.15,0,.25-.06.1-.06.25,0,.2-.12-.05-.12-.05-.18-.1-.18h-.1Z");
    			attr(path164, "d", "m123.02,40.75h-.25c-.1,0-.1.12-.2.12s-.15.06-.2.12c-.05.06.05.12-.05.12s0-.12-.1-.12-.2-.06-.15.06c.05.12-.05.12.1.18.15.06.15,0,.25.06.1.06.2.06.15.18-.05.12,0,.18.1.18h.35c.1,0,.25,0,.25.06s-.3.06-.3.12.05.18-.05.12q-.1-.06-.15-.06s-.25,0-.15.06c.1.06.2.06.2.12s.15.12.15.18-.05,0-.05.12.1.24.15.18c.05-.06.15-.24.2-.18.05.06.1.18.2.18s.35.18.45.18.2,0,.3.06c.1.06.4.3.5.3s.15,0,.2.18c.05.18.2.36.25.42.05.06.05.12,0,.24-.05.12-.4.61-.35.67.05.06,0,.12.15.12s.6-.12.69-.12.2,0,.2.12.25.36.4.36h.5c.1,0,.15.06.25,0,.1-.06.25,0,.2-.12-.05-.12,0-.18-.1-.24-.1-.06,0-.18.05-.18s.25,0,.25-.12.1-.18.2-.12c.1.06.35.18.45.18s.15-.06.2.12c.05.18.45.61.5.73.05.12.05.18.2.18s.5,0,.6.06c.1.06.1.18.25.18s.35,0,.25-.12c-.1-.12-.05-.12-.2-.24-.15-.12-.4-.24-.45-.3q-.05-.06-.1-.18c-.05-.12-.05-.18-.15-.24-.1-.06-.35-.3-.4-.42-.05-.12-.2-.24-.15-.3.05-.06.1-.12.2-.12s.2.06.1-.12c-.1-.18-.05-.24-.25-.24s-.35-.12-.45-.24q-.1-.12-.1-.24c0-.12-.4-.49-.55-.55-.15-.06-1.04-.42-1.09-.48-.05-.06-.5-.12-.6-.24-.1-.12-.35-.3-.5-.3s-.35-.12-.45-.12-.35.36-.5.42c-.15.06-.25.18-.3.3s-.05.3-.15.24c-.1-.06-.25-.3-.3-.42-.05-.12-.1-.06-.15-.18-.05-.12-.05-.36-.05-.49s.05-.18-.1-.24c-.15-.06-.15,0-.25-.06-.1-.06,0-.12-.1-.12Z");
    			attr(path165, "d", "m120.14,44.32s.1.06.2,0c.1-.06.15-.18.2-.06q.05.12-.1.18c-.15.06-.25.06-.3,0-.05-.06-.05-.12,0-.12Z");
    			attr(path166, "d", "m122.37,44.14s-.2.06-.15.18c.05.12,0,.12-.05.24-.05.12-.15.24.05.06.2-.18.35-.3.35-.42s-.15-.12-.2-.06Z");
    			attr(path167, "d", "m123.56,43.23s-.15,0-.1.06c.05.06,0,.18,0,.24s-.1.18-.05.3c.05.12.15.06.2,0,.05-.06.2-.12.15-.24-.05-.12-.05-.36-.05-.36h-.15Z");
    			attr(path168, "d", "m124.11,40.93l.15.12c.15.12.35.12.25.18-.1.06-.15.06-.3,0-.15-.06-.15,0-.2-.12-.05-.12,0-.24.1-.18Z");
    			attr(path169, "d", "m124.01,41.41s.05.06.2,0c.15-.06.2-.06.25,0,.05.06.2.12.05.12s-.15-.06-.3,0c-.15.06-.35-.12-.2-.12Z");
    			attr(path170, "d", "m128.43,41.53s.35,0,.3.06c-.05.06-.05.12-.2.12s-.35-.18-.1-.18Z");
    			attr(path171, "d", "m129.72,41.78s.15-.06.2,0c.05.06,0,.12-.1.12s-.15-.12-.1-.12Z");
    			attr(path172, "d", "m130.16,41.84s.25.24.35.3c.1.06.4.3.4.36s.2.3.1.36q-.1.06-.15-.06c-.05-.12,0-.18-.1-.3-.1-.12-.4-.3-.45-.36-.05-.06-.1,0-.15-.12-.05-.12-.2-.12,0-.18Z");
    			attr(path173, "d", "m129.47,43.23s-.4-.06-.4,0,0,.12.1.18c.1.06.3.24.45.24s.25,0,.35-.06c.1-.06.15-.06.3-.12.15-.06.15-.18.25-.18s.15-.18.15-.24.1,0,.1-.12-.05-.18-.1-.24c-.05-.06-.2-.06-.25-.06s-.15-.06-.1.06c.05.12.2.3.1.3s-.15,0-.2.06c-.05.06-.05.18-.15.18s-.2,0-.2-.06,0-.24-.1-.12c-.1.12-.15.18-.2.18h-.1Z");
    			attr(path174, "d", "m131.6,43.23v.24c0,.12.05.06.1.12.05.06,0,.12.1.24.1.12.15.24.2.12.05-.12.2-.18.15-.24-.05-.06-.05-.12-.15-.18-.1-.06-.1,0-.15-.12q-.05-.12-.1-.18c-.05-.06-.15-.12-.15,0Z");
    			attr(path175, "d", "m132.3,43.78s.1.06.15.18c.05.12.05.24.15.24s.2,0,.15-.06q-.05-.06-.15-.18c-.1-.12-.05-.24-.15-.24s-.3-.06-.15.06Z");
    			attr(path176, "d", "m132.35,44.32s-.05.12.1.18c.15.06.2,0,.25.12.05.12.15.24.2.24s.2.06.15-.06c-.05-.12-.1-.12-.15-.18-.05-.06-.05-.12-.15-.18-.1-.06-.2,0-.25-.06-.05-.06-.1-.12-.15-.06Z");
    			attr(path177, "d", "m133.14,44.32s.2.06.25.18c.05.12.1.24.2.24s.15-.12.05-.18c-.1-.06-.15-.06-.2-.18q-.05-.12-.2-.18c-.15-.06-.25.06-.1.12Z");
    			attr(path178, "d", "m133.69,45.17s-.05-.12-.1-.06c-.05.06-.1.12,0,.18.1.06.25.12.3.12s.2.12.2,0,.05-.24-.1-.24-.3.06-.3,0Z");
    			attr(path179, "d", "m133.98,44.69s0,.18.05.3c.05.12.1.18.15.24.05.06.2.18.15.06-.05-.12-.15-.18-.15-.3s.1-.12,0-.24-.2-.24-.2-.06Z");
    			attr(path180, "d", "m134.23,45.54s.05.06.1.18c.05.12.1.24.2.18.1-.06.2-.12.1-.18-.1-.06-.15-.06-.2-.12-.05-.06-.25-.12-.2-.06Z");
    			attr(path181, "d", "m129.77,45.23s.15,0,.2.06c.05.06.1.12.15.18.05.06.3.12.2,0-.1-.12-.2-.06-.2-.18s0-.18-.1-.18-.15-.06-.2-.06-.1.18-.05.18Z");
    			attr(path182, "d", "m136.29,47.81s.05.06.05.24.15.18.2.18.05-.06.05-.18-.05-.06-.1-.24c-.05-.18-.2-.12-.2,0Z");
    			attr(path183, "d", "m136.56,48.39s.1.06.1.12,0,.24.1.18c.1-.06.15-.12.05-.24-.1-.12-.3-.12-.25-.06Z");
    			attr(path184, "d", "m136.96,49.18s.3.12.25.06c-.05-.06,0-.24-.1-.24s-.2.12-.15.18Z");
    			attr(path185, "d", "m137.26,49.72s-.05.06.05.12c.1.06.2,0,.15-.12-.05-.12-.2-.06-.2,0Z");
    			attr(path186, "d", "m135.42,50.33s-.25-.12-.2,0,.4.54.5.67c.1.12.25.18.4.3.15.12.35.18.4.12.05-.06.1-.12-.1-.24-.2-.12-.5-.48-.6-.54-.1-.06-.4-.3-.4-.3Z");
    			attr(path187, "d", "m136.51,50.76s0,.12.1.12.15-.06.1-.12c-.05-.06,0-.18-.1-.18s-.1.12-.1.18Z");
    			attr(path188, "d", "m136.81,51.06s.1.12.15.06c.05-.06.05-.18,0-.18s-.2,0-.15.12Z");
    			attr(path189, "d", "m136.17,50.57s.15.18.2.06c.05-.12.15-.18.05-.18s-.3,0-.25.12Z");
    			attr(path190, "d", "m115.48,53.85s-.05.3.05.42c.1.12.15.12.2.3.05.18.05.48.1.67.05.18.15.55.25.67.1.12.1.24.05.48-.05.24.05.48-.05.55-.1.06-.2-.12-.2,0s0,.3.1.36c.1.06.69.42.84.36.15-.06.3-.18.45-.24.15-.06.25.12.3-.06q.05-.18.3-.24c.25-.06,1.34.12,1.44,0,.1-.12.05-.48.2-.48s.4-.12.59-.24c.2-.12.2-.18.5-.12.3.06.79-.12.89-.24.1-.12.6-.18.74-.12.15.06.35.12.45.18.1.06.15-.06.25,0,.1.06.3-.06.4.12.1.18.25.12.2.3-.05.18.05.06.15.18s.2.24.25.36q.05.12,0,.24c-.05.12,0,.24.15.18.15-.06,0-.06.15-.18.15-.12.5-.12.5-.3s.05-.24.1-.3c.05-.06.25-.18.15.06-.1.24-.1.36-.15.55-.05.18-.15.12-.2.24-.05.12-.15.3,0,.18.15-.12.35,0,.35-.18s0-.42.1-.3c.1.12.25.54.1.61-.15.06-.1,0-.3,0s-.6,0-.5.12c.1.12.35.06.45.06s.3-.12.45-.12.5.36.45.42c-.05.06,0,.18,0,.3s.3.36.3.42.15-.06.35,0c.2.06.3.12.5.24.2.12.25.18.4.12.15-.06.3-.3.4-.36.1-.06.2-.06.15.12-.05.18-.15,0,.1.12.25.12.35.18.45.12.1-.06,0,.06.25-.12.25-.18.74-.49.94-.42.2.06.25.06.25-.12s.15-.91.3-1.15c.15-.24.15-.36.2-.54.05-.18-.05-.18.2-.36.25-.18.4-.18.4-.42s.15-.24.15-.48-.1-.36-.05-.48c.05-.12.15-.42.2-.61.05-.18.05-.54,0-.67s-.2-.67-.15-.91c.05-.24.1-.24.1-.42s.05-.36-.1-.12c-.15.24-.25.06-.3,0-.05-.06-.2-.3-.35-.42-.15-.12-.15-.18-.2-.3-.05-.12-.1-.3-.2-.36-.1-.06-.15-.42-.2-.3-.05.12-.05.49-.15.3-.1-.18-.05-.55-.1-.61-.05-.06-.2-.18-.2-.3s.1-.12-.15-.24c-.25-.12-.6-.36-.74-.49-.15-.12-.1-.3-.1-.42s0,0-.05-.18c-.05-.18-.1-.42-.2-.54-.1-.12-.05-.49-.1-.67-.05-.18.1-.12-.1-.3-.2-.18-.15-.24-.25-.24s-.1.3-.25.12c-.15-.18-.1-.48-.15-.73-.05-.24-.15-.18-.2-.36-.05-.18-.05-.42-.15-.61-.1-.18-.3-.06-.3.12s-.1.49-.15.67c-.05.18-.05.36-.05.55s.1.79,0,.97c-.1.18-.2.55-.3.67-.1.12-.05.36-.15.24-.1-.12-.1-.18-.15-.36-.05-.18-.25-.36-.35-.24-.1.12-.25.24-.35.12-.1-.12-.2-.3-.3-.36-.1-.06-.35-.49-.25-.55s.2,0,.15-.18c-.05-.18-.1-.36-.15-.49-.05-.12,0-.12.05-.3.05-.18-.05-.18-.05-.36s.1-.55,0-.48c-.1.06-.35.3-.5.42-.15.12-.35.24-.4.12-.05-.12-.4-.24-.5-.24s-.2-.18-.25-.12c-.05.06,0,.18-.1.24-.1.06-.05.18-.25.12q-.2-.06-.2-.12c0-.06.2-.3-.05-.3s-.45.06-.45.12-.25.12-.05.18c.2.06.35,0,.4.06.05.06,0,.06-.1.18-.1.12-.35.36-.3.48.05.12,0,.18-.05.24-.05.06-.3.18-.2.3s.25.12.15.24-.3,0-.45-.06c-.15-.06-.1-.06-.25-.18-.15-.12-.35-.36-.45-.3-.1.06-.2.12-.4.18-.2.06-.2.18-.25.3-.05.12-.15.18-.25.24-.1.06-.05.24-.05.3s-.1.3-.2.18c-.1-.12-.15-.24-.25-.18-.1.06.2.24.15.42-.05.18-.15.24-.2.12-.05-.12-.15-.36-.25-.24-.1.12-.25.24-.2.42s.15.18.05.3c-.1.12-.45.36-.45.61s-.4.42-.64.36c-.25-.06-.3.06-.5.12-.2.06-.45.3-.6.18-.15-.12-.15-.06-.3.06-.15.12-.45.36-.5.42-.05.06,0,.18-.1.24-.1.06-.05,0-.15-.12-.1-.12-.15-.18-.15.06s.1.36,0,.55c-.1.18-.2.18-.15.36.05.18.35.73.35.91s-.1.42-.15.18-.2-.55-.2-.36.1.36,0,.42c-.1.06-.15.06,0,.18.15.12.25.24.25.3Z");
    			attr(path191, "d", "m127.26,59.88c0,.06-.05.24.05.24s.2-.06.2-.18-.05-.24-.1-.18c-.05.06-.15,0-.15.12Z");
    			attr(path192, "d", "m127.63,60.34s-.1.24.05.42c.15.18.15.06.15.24s.15.49.2.55c.05.06.25.3.4.24.15-.06.2-.3.3-.3s.2.12.2,0,0-.24.05-.3c.05-.06.15,0,.15-.12s.05-.61,0-.67c-.05-.06-.15-.06-.3,0-.15.06-.3.12-.45.06-.15-.06-.54-.06-.6-.18-.05-.12-.1-.06-.15.06Z");
    			attr(path193, "d", "m128.92,59.97s.05,0,.05.12.1.24.15.18q.05-.06.05-.18c0-.12,0-.24-.1-.24s-.25.06-.15.12Z");
    			attr(path194, "d", "m136.76,62.22s-.5.36-.5.54,0,.24.15.24.25-.06.3,0c.05.06.15.18.35.18s.45.06.55,0c.1-.06.35-.24.4-.48.05-.24.2-.18.25-.42s.4-.3.54-.36c.15-.06.2-.06.1-.18-.1-.12,0-.24.1-.3.1-.06.25-.36.3-.48.05-.12.15-.06.15-.18s.05-.18,0-.24c-.05-.06-.2-.18-.25-.12-.05.06-.05.18-.15.18s-.15-.12-.15-.18-.05,0-.1-.06c-.05-.06-.1-.12-.15-.06-.05.06-.15.3-.25.42-.1.12-.2.06-.2.24s-.25.55-.35.55-.15.06-.3.18c-.15.12-.25.18-.4.18s-.4.36-.4.36Z");
    			attr(path195, "d", "m139.74,60.16s-.05.24-.1.3c-.05.06,0,.24.05.24s0,.12.15.06c.15-.06.45-.36.5-.49.05-.12.1-.36.15-.48.05-.12.1-.36.2-.24.1.12.2-.12.2-.18s.1.06.15-.12c.05-.18,0-.18.05-.3.05-.12-.1-.18-.2-.12-.1.06-.35.3-.5.18s-.3-.18-.3-.3-.1-.36-.15-.36-.15.06-.1.18c.05.12-.15-.06-.2-.06s-.05-.18-.05-.24-.15-.06-.1-.18q.05-.12,0-.24c-.05-.12-.35-.24-.4-.24s-.1-.06-.15-.18c-.05-.12-.2-.24-.2-.18s.05.3.1.36c.05.06.05.24.25.42.2.18.54.73.5.91s0,.48-.05.55c-.05.06,0,0-.15.06-.15.06-.35,0-.25.12.1.12.3.24.4.3.1.06.25.12.2.24Z");
    			attr(g3, "id", "world-paths");
    			attr(svg7, "id", "world");
    			attr(svg7, "viewBox", "0 0 145.87 67.56");
    			attr(div10, "id", "bank-card");
    			attr(div10, "class", "bank-card");
    			attr(div10, "style", /*dynamicStyles*/ ctx[3]);
    		},
    		m(target, anchor) {
    			insert(target, div10, anchor);
    			append(div10, button);
    			append(div10, t14);
    			append(div10, svg4);
    			append(svg4, g0);
    			append(g0, polyline0);
    			append(g0, polyline1);
    			append(g0, polyline2);
    			append(g0, polyline3);
    			append(g0, polyline4);
    			append(g0, polyline5);
    			append(g0, polyline6);
    			append(g0, polyline7);
    			append(g0, polyline8);
    			append(div10, t15);
    			append(div10, svg5);
    			append(svg5, g1);
    			append(g1, path0);
    			append(g1, path1);
    			append(g1, path2);
    			append(div10, t16);
    			append(div10, svg6);
    			append(svg6, g2);
    			append(g2, path3);
    			append(g2, path4);
    			append(g2, path5);
    			append(g2, path6);
    			append(g2, path7);
    			append(g2, path8);
    			append(g2, path9);
    			append(g2, path10);
    			append(g2, path11);
    			append(g2, path12);
    			append(div10, t17);
    			append(div10, svg7);
    			append(svg7, g3);
    			append(g3, path13);
    			append(g3, path14);
    			append(g3, path15);
    			append(g3, path16);
    			append(g3, path17);
    			append(g3, path18);
    			append(g3, path19);
    			append(g3, path20);
    			append(g3, path21);
    			append(g3, path22);
    			append(g3, path23);
    			append(g3, path24);
    			append(g3, path25);
    			append(g3, path26);
    			append(g3, path27);
    			append(g3, path28);
    			append(g3, path29);
    			append(g3, path30);
    			append(g3, path31);
    			append(g3, path32);
    			append(g3, path33);
    			append(g3, path34);
    			append(g3, path35);
    			append(g3, path36);
    			append(g3, path37);
    			append(g3, path38);
    			append(g3, path39);
    			append(g3, path40);
    			append(g3, path41);
    			append(g3, path42);
    			append(g3, path43);
    			append(g3, path44);
    			append(g3, path45);
    			append(g3, path46);
    			append(g3, path47);
    			append(g3, path48);
    			append(g3, path49);
    			append(g3, path50);
    			append(g3, path51);
    			append(g3, path52);
    			append(g3, path53);
    			append(g3, path54);
    			append(g3, path55);
    			append(g3, path56);
    			append(g3, path57);
    			append(g3, path58);
    			append(g3, path59);
    			append(g3, path60);
    			append(g3, path61);
    			append(g3, path62);
    			append(g3, path63);
    			append(g3, path64);
    			append(g3, path65);
    			append(g3, path66);
    			append(g3, path67);
    			append(g3, path68);
    			append(g3, path69);
    			append(g3, path70);
    			append(g3, path71);
    			append(g3, path72);
    			append(g3, path73);
    			append(g3, path74);
    			append(g3, path75);
    			append(g3, path76);
    			append(g3, path77);
    			append(g3, path78);
    			append(g3, path79);
    			append(g3, path80);
    			append(g3, path81);
    			append(g3, path82);
    			append(g3, path83);
    			append(g3, path84);
    			append(g3, path85);
    			append(g3, path86);
    			append(g3, path87);
    			append(g3, path88);
    			append(g3, path89);
    			append(g3, path90);
    			append(g3, path91);
    			append(g3, path92);
    			append(g3, path93);
    			append(g3, path94);
    			append(g3, path95);
    			append(g3, path96);
    			append(g3, path97);
    			append(g3, path98);
    			append(g3, path99);
    			append(g3, path100);
    			append(g3, path101);
    			append(g3, path102);
    			append(g3, path103);
    			append(g3, path104);
    			append(g3, path105);
    			append(g3, path106);
    			append(g3, path107);
    			append(g3, path108);
    			append(g3, path109);
    			append(g3, path110);
    			append(g3, path111);
    			append(g3, path112);
    			append(g3, path113);
    			append(g3, path114);
    			append(g3, path115);
    			append(g3, path116);
    			append(g3, path117);
    			append(g3, path118);
    			append(g3, path119);
    			append(g3, path120);
    			append(g3, path121);
    			append(g3, path122);
    			append(g3, path123);
    			append(g3, path124);
    			append(g3, path125);
    			append(g3, path126);
    			append(g3, path127);
    			append(g3, path128);
    			append(g3, path129);
    			append(g3, path130);
    			append(g3, path131);
    			append(g3, path132);
    			append(g3, path133);
    			append(g3, path134);
    			append(g3, path135);
    			append(g3, path136);
    			append(g3, path137);
    			append(g3, path138);
    			append(g3, path139);
    			append(g3, path140);
    			append(g3, path141);
    			append(g3, path142);
    			append(g3, path143);
    			append(g3, path144);
    			append(g3, path145);
    			append(g3, path146);
    			append(g3, path147);
    			append(g3, path148);
    			append(g3, path149);
    			append(g3, path150);
    			append(g3, path151);
    			append(g3, path152);
    			append(g3, path153);
    			append(g3, path154);
    			append(g3, path155);
    			append(g3, path156);
    			append(g3, path157);
    			append(g3, path158);
    			append(g3, path159);
    			append(g3, path160);
    			append(g3, path161);
    			append(g3, path162);
    			append(g3, path163);
    			append(g3, path164);
    			append(g3, path165);
    			append(g3, path166);
    			append(g3, path167);
    			append(g3, path168);
    			append(g3, path169);
    			append(g3, path170);
    			append(g3, path171);
    			append(g3, path172);
    			append(g3, path173);
    			append(g3, path174);
    			append(g3, path175);
    			append(g3, path176);
    			append(g3, path177);
    			append(g3, path178);
    			append(g3, path179);
    			append(g3, path180);
    			append(g3, path181);
    			append(g3, path182);
    			append(g3, path183);
    			append(g3, path184);
    			append(g3, path185);
    			append(g3, path186);
    			append(g3, path187);
    			append(g3, path188);
    			append(g3, path189);
    			append(g3, path190);
    			append(g3, path191);
    			append(g3, path192);
    			append(g3, path193);
    			append(g3, path194);
    			append(g3, path195);

    			if (!mounted) {
    				dispose = [
    					action_destroyer(/*outClick*/ ctx[4].call(null, button)),
    					listen(button, "pointermove", /*interact*/ ctx[5]),
    					listen(button, "mouseout", /*interactEnd*/ ctx[6]),
    					listen(button, "blur", /*interactEnd*/ ctx[6]),
    					listen(button, "outclick", /*outclick_handler*/ ctx[10])
    				];

    				mounted = true;
    			}
    		},
    		p(ctx, [dirty]) {
    			if (dirty & /*dynamicStyles*/ 8) {
    				attr(div10, "style", /*dynamicStyles*/ ctx[3]);
    			}
    		},
    		i: noop,
    		o: noop,
    		d(detaching) {
    			if (detaching) detach(div10);
    			mounted = false;
    			run_all(dispose);
    		}
    	};
    }

    function instance($$self, $$props, $$invalidate) {
    	let dynamicStyles;
    	let $springBackground;
    	let $springRotate;
    	let $springGlare;
    	const springInteractSettings = { stiffness: 0.066, damping: 0.25 };

    	// setting up the spring values in their "rest" state
    	// using svelte's spring stores
    	let springRotate = spring({ x: 0, y: 0 }, springInteractSettings);

    	component_subscribe($$self, springRotate, value => $$invalidate(8, $springRotate = value));
    	let springGlare = spring({ x: 50, y: 50, o: 0 }, springInteractSettings);
    	component_subscribe($$self, springGlare, value => $$invalidate(9, $springGlare = value));
    	let springBackground = spring({ x: 50, y: 50 }, springInteractSettings);
    	component_subscribe($$self, springBackground, value => $$invalidate(7, $springBackground = value));

    	/**
     * return a value that has been rounded to a set precision
     * @param {Number} value the value to round
     * @param {Number} precision the precision (decimal places), default: 3
     * @returns {Number}
     */
    	const round = (value, precision = 3) => parseFloat(value.toFixed(precision));

    	/**
     * return a value that has been limited between min & max
     * @param {Number} value the value to clamp
     * @param {Number} min minimum value to allow, default: 0
     * @param {Number} max maximum value to allow, default: 100
     * @returns {Number}
     */
    	const clamp = (value, min = 0, max = 100) => {
    		return Math.min(Math.max(value, min), max);
    	};

    	/**
     * return a value that has been re-mapped according to the from/to
     * - for example, adjust(10, 0, 100, 100, 0) = 90
     * @param {Number} value the value to re-map (or adjust)
     * @param {Number} fromMin min value to re-map from
     * @param {Number} fromMax max value to re-map from
     * @param {Number} toMin min value to re-map to
     * @param {Number} toMax max value to re-map to
     * @returns {Number} 
     */
    	const adjust = (value, fromMin, fromMax, toMin, toMax) => {
    		return round(toMin + (toMax - toMin) * (value - fromMin) / (fromMax - fromMin));
    	};

    	/**
     * a helper action to handle clicking outside of an element
     * to be used as an action on the element you want to detect clicks outside of
     * @param {Element} node the element to detect clicks outside of
     * @returns {Object} - a svelte action
     */
    	const outClick = node => {
    		const handleClick = event => {
    			if (node && !node.contains(event.target) && !event.defaultPrevented) {
    				node.dispatchEvent(new CustomEvent("outclick", node));
    			}
    		};

    		document.addEventListener("click", handleClick, true);

    		return {
    			destroy() {
    				document.removeEventListener("click", handleClick, true);
    			}
    		};
    	};

    	/**
     * update the spring values with new values
     * @param {Object} background - the background position
     * @param {Object} rotate - the rotation
     * @param {Object} glare - the glare position
     * @param {Object} damping - the damping value
     * @param {Object} stiffness - the stiffness value
     */
    	const updateSprings = (background, rotate, glare, damping = springInteractSettings.damping, stiffness = springInteractSettings.stiffness) => {
    		$$invalidate(2, springBackground.stiffness = stiffness, springBackground);
    		$$invalidate(2, springBackground.damping = damping, springBackground);
    		springBackground.set(background);
    		$$invalidate(0, springRotate.stiffness = stiffness, springRotate);
    		$$invalidate(0, springRotate.damping = damping, springRotate);
    		springRotate.set(rotate);
    		$$invalidate(1, springGlare.stiffness = stiffness, springGlare);
    		$$invalidate(1, springGlare.damping = damping, springGlare);
    		springGlare.set(glare);
    	};

    	const interact = e => {
    		// un-comment this code to prevent interaction on safari
    		// if (isSafari()) return;
    		if (e.type === "touchmove") {
    			e.clientX = e.touches[0].clientX;
    			e.clientY = e.touches[0].clientY;
    		}

    		const $el = e.target;
    		const rect = $el.getBoundingClientRect(); // get element's current size/position

    		const absolute = {
    			x: e.clientX - rect.left, // get mouse position from left
    			y: e.clientY - rect.top, // get mouse position from right
    			
    		};

    		const percent = {
    			x: clamp(round(100 / rect.width * absolute.x)),
    			y: clamp(round(100 / rect.height * absolute.y))
    		};

    		const center = { x: percent.x - 50, y: percent.y - 50 };

    		updateSprings(
    			{
    				x: adjust(percent.x, 0, 100, 37, 63),
    				y: adjust(percent.y, 0, 100, 33, 67)
    			},
    			{
    				x: round(-(center.x / 3.5)),
    				y: round(center.y / 2)
    			},
    			{
    				x: round(percent.x),
    				y: round(percent.y),
    				o: 1
    			}
    		);
    	};

    	/**
     * reset the spring values to their "rest" state
     * @param {Event} e - the event
     * @param {Number} delay - the delay before resetting the spring values
     */
    	const interactEnd = (e, delay = 500) => {
    		setTimeout(
    			function () {
    				const snapStiff = 0.01;
    				const snapDamp = 0.06;
    				$$invalidate(0, springRotate.stiffness = snapStiff, springRotate);
    				$$invalidate(0, springRotate.damping = snapDamp, springRotate);
    				springRotate.set({ x: 0, y: 0 }, { soft: 1 });
    				$$invalidate(1, springGlare.stiffness = snapStiff, springGlare);
    				$$invalidate(1, springGlare.damping = snapDamp, springGlare);
    				springGlare.set({ x: 50, y: 50, o: 0 }, { soft: 1 });
    				$$invalidate(2, springBackground.stiffness = snapStiff, springBackground);
    				$$invalidate(2, springBackground.damping = snapDamp, springBackground);
    				springBackground.set({ x: 50, y: 50 }, { soft: 1 });
    			},
    			delay
    		);
    	};

    	onMount(() => {
    		const snapStiff = 0.005;
    		const snapDamp = 0.1;
    		updateSprings({ x: 75, y: 50 }, { x: 12, y: 0 }, { x: 75, y: 50, o: 1 }, snapDamp, snapStiff);

    		setTimeout(
    			() => {
    				updateSprings({ x: 25, y: 50 }, { x: -12, y: 0 }, { x: 25, y: 50, o: 1 }, snapDamp, snapStiff);
    			},
    			1500
    		);

    		setTimeout(
    			() => {
    				updateSprings({ x: 50, y: 50 }, { x: 0, y: 0 }, { x: 50, y: 50, o: 1 }, snapDamp, snapStiff);
    			},
    			3000
    		);
    	});

    	const outclick_handler = e => {
    		interactEnd(e, 0);
    	};

    	$$self.$$.update = () => {
    		if ($$self.$$.dirty & /*$springGlare, $springRotate, $springBackground*/ 896) {
    			// this is a Svelte Reactive Statement (like a computed property)
    			// we're using this to update all the CSS variables as they change
    			$$invalidate(3, dynamicStyles = `
    --pointer-x: ${clamp($springGlare.x)}%;
    --pointer-y: ${clamp($springGlare.y)}%;
    --pointer-from-center: ${clamp(Math.sqrt(($springGlare.y - 50) * ($springGlare.y - 50) + ($springGlare.x - 50) * ($springGlare.x - 50)) / 50, 0, 1)};
    --pointer-from-top: ${clamp($springGlare.y / 100)};
    --pointer-from-left: ${clamp($springGlare.x / 100)};
    --opacity: ${clamp($springGlare.o)};
    --rotate-x: ${$springRotate.x}deg;
    --rotate-y: ${$springRotate.y}deg;
    --background-x: ${$springBackground.x}%;
    --background-y: ${$springBackground.y}%;
	`);
    		}
    	};

    	return [
    		springRotate,
    		springGlare,
    		springBackground,
    		dynamicStyles,
    		outClick,
    		interact,
    		interactEnd,
    		$springBackground,
    		$springRotate,
    		$springGlare,
    		outclick_handler
    	];
    }

    class Card extends SvelteElement {
    	constructor(options) {
    		super();
    		const style = document.createElement('style');

    		style.textContent = `:root{--pointer-x:50%;--pointer-y:50%;--rotate-x:0deg;--rotate-y:0deg;--background-x:var(--pointer-x);--background-y:var(--pointer-y);--pointer-from-center:0;--pointer-from-left:0.5;--pointer-from-top:0.5}.bank-card{--bg:hsla(0, 0%, 100%, .05);--card-aspect:1.545;--card-radius:3% / 5.25%;--logo-3d-distance:-5px;--backdrop:blur(10px);--img_BANK:url(https://assets.codepen.io/13471/bank-text.svg);--img_RFID:url(https://assets.codepen.io/13471/rfid-cc.svg);--img_WORLD:url(https://assets.codepen.io/13471/world.svg);--img_FOIL:url(https://assets.codepen.io/13471/iridescent.webp);--img_TEXTURE:url(https://assets.codepen.io/13471/frosted-glass.webp)}.bank-card{font-size:16px;width:85vw;max-width:52em;max-height:90vh;aspect-ratio:var(--card-aspect);display:grid;grid-template-columns:1fr;grid-template-rows:1fr;align-items:center;justify-content:center;position:relative;text-align:center;isolation:isolate;-webkit-transform:translate3d(0px, 0px, 0.01px);transform:translate3d(0px, 0px, 0.01px);-webkit-transform-style:preserve-3d;transform-style:preserve-3d;pointer-events:none;perspective:600px;z-index:2;will-change:transform, visibility, z-index}.bank-rotator{display:grid;grid-area:1 / 1;position:relative;place-items:center;height:100%;aspect-ratio:var(--card-aspect);border-radius:var(--card-radius);background:var(--bg);box-shadow:0px calc(13px * var(--pointer-from-top)) 20px -5px hsla(0, 0%, 0%, calc(0.6 * var(--pointer-from-top))), 
      0 2px 15px -5px hsla(0, 0%, 0%, calc(0.5 * var(--pointer-from-center) + 0.33 )), 
      inset 0 0 30px -7px rgba(255,255,255,0.75);-webkit-backdrop-filter:brightness(1.2) contrast(1.2) var(--backdrop);backdrop-filter:brightness(1.2) contrast(1.2) var(--backdrop);will-change:transform, box-shadow;-webkit-transform-origin:center;transform-origin:center;-webkit-transform:rotateY(var(--rotate-x)) rotateX(var(--rotate-y));transform:rotateY(var(--rotate-x)) rotateX(var(--rotate-y));-webkit-transform-style:preserve-3d;transform-style:preserve-3d;pointer-events:auto;overflow:hidden;isolation:isolate;touch-action:none;z-index:3}.bank-rotator>*{grid-area:1 / 1;pointer-events:none}.bank-card__border,.bank-card__border-bottom{position:absolute;top:0;width:100%;height:1px;background-image:linear-gradient(45deg, 
      transparent 25%, 
      white 50%, 
      transparent 75%
    );background-size:200% 200%;background-repeat:no-repeat;background-position-x:calc(var(--pointer-x) + 25%);-webkit-mask-image:linear-gradient(90deg, transparent, white 15%, white 85%, transparent);mask-image:linear-gradient(90deg, transparent, white 15%, white 85%, transparent);-webkit-mask-size:100% 100%;mask-size:100% 100%;-webkit-mask-position:center;mask-position:center;-webkit-mask-repeat:no-repeat;mask-repeat:no-repeat;z-index:5}.bank-card__border-bottom{background-position-x:calc(var(--pointer-x) - 25%);top:auto;bottom:0
  }.bank-card__rfid{width:100%;height:100%;background-image:linear-gradient(125deg, #8c534248 13%, #dbac92de 26%, #8c534248 53%, #dbac92de 76%, #75503c2c );background-size:200% 200%;background-position-x:var(--pointer-x);background-position-y:var(--pointer-y);-webkit-mask-image:var(--img_RFID);mask-image:var(--img_RFID);-webkit-mask-size:88%;mask-size:88%;-webkit-mask-position:center center;mask-position:center center;-webkit-mask-repeat:no-repeat;mask-repeat:no-repeat;opacity:0.3;z-index:2}.bank-card__logo,.bank-card__shine{align-self:flex-end;width:100%;height:100%;margin:0;mask-image:var(--img_BANK);-webkit-mask-image:var(--img_BANK);mask-size:88%;-webkit-mask-size:88%;mask-position:center 92%;-webkit-mask-position:center 92%;-webkit-mask-repeat:no-repeat;mask-repeat:no-repeat;background-image:linear-gradient(12deg, #99ffcfa3, #df97ff91), var(--img_FOIL);background-image:linear-gradient(120deg, #99ffcfa3, #df97ff91), 
      var(--img_FOIL), 
      linear-gradient(90deg, #a4a4a4, #ffffff59, #a4a4a4);background-size:120% 120%;background-position:center, calc(var(--background-x) * -0.5) calc(var(--background-y) * -0.5 + 0%), center;;;background-blend-mode:color-burn, overlay;filter:brightness(calc(.78 * (1.5 - var(--opacity) * 0.5) + (0.25 - var(--pointer-from-center) * 0.25 ))) 
      contrast(3) 
      saturate(2) 
      hue-rotate(calc(180deg * (var(--pointer-from-left) + var(--pointer-from-top)) + 180deg));z-index:4}.bank-card__shine{--space:5%;--angle:-22deg;--imgsize:300% 400%;display:grid;background-image:repeating-linear-gradient( 
        var(--angle), 
      hsla(283, 49%, 60%, 0.75) calc(var(--space)*1), 
      hsla(2, 74%, 59%, 0.75) calc(var(--space)*2), 
      hsla(53, 67%, 53%, 0.75) calc(var(--space)*3), 
      hsla(93, 56%, 52%, 0.75) calc(var(--space)*4), 
      hsla(176, 38%, 50%, 0.75) calc(var(--space)*5), 
      hsla(228, 100%, 77%, 0.75) calc(var(--space)*6), 
      hsla(283, 49%, 61%, 0.75) calc(var(--space)*7) 
    );background-size:var(--imgsize);background-position:var(--background-x) calc(var(--background-y) * 1);filter:brightness(calc((var(--pointer-from-center)*0.35) + 0.45)) contrast(2) saturate(3);mix-blend-mode:exclusion}.bank-card__shine::after{--space:4%;content:"";width:100%;height:100%;margin:0;background-image:radial-gradient( 
        farthest-corner 
        ellipse at calc( ((var(--background-x)) * 0.5) + 25% ) calc( ((var(--background-y)) * 0.5) + 25% ), 
        hsla(53, 67%, 53%, 0.75) calc( var(--space) * 1 ), 
        hsla(93, 56%, 52%, 0.75) calc( var(--space) * 2 ), 
        hsla(176, 38%, 50%, 0.75) calc( var(--space) * 3 ), 
        hsla(228, 100%, 77%, 0.75) calc( var(--space) * 4 ), 
        hsla(283, 49%, 61%, 0.75) calc( var(--space) * 5 )
      );background-position:center center;background-size:400% 500%;filter:brightness(calc((var(--pointer-from-center)*0.2) + 0.2)) contrast(.85) saturate(1.1);-webkit-mask-image:var(--img_BANK);mask-image:var(--img_BANK);-webkit-mask-size:88%;mask-size:88%;-webkit-mask-position:center 92%;mask-position:center 92%;-webkit-mask-repeat:no-repeat;mask-repeat:no-repeat;mix-blend-mode:saturation}.bank-card__logo,.bank-card__shine,.bank-card__shine:after{opacity:calc( 1.5 - var(--pointer-from-center) * 0.75)}.bank-card__logo-outline{width:100%;height:100%;-webkit-mask-image:linear-gradient(100deg, hsla(0, 0%, 100%, 0) 33%, hsl(0, 0%, 100%), hsla(0, 0%, 100%, 0) 66%);mask-image:linear-gradient(100deg, hsla(0, 0%, 100%, 0) 33%, hsl(0, 0%, 100%), hsla(0, 0%, 100%, 0) 66%);-webkit-mask-size:150% 150%;mask-size:150% 150%;-webkit-mask-position:var(--pointer-x) var(--pointer-y);mask-position:var(--pointer-x) var(--pointer-y);-webkit-mask-repeat:no-repeat;mask-repeat:no-repeat;filter:brightness(5) contrast(1) 
      hue-rotate(calc(180deg * (var(--pointer-from-left) + var(--pointer-from-top)) + 180deg));mix-blend-mode:plus-lighter;opacity:0.7;z-index:5}.bank-card__logo-outline>svg{position:relative;width:88%;top:76.33%;fill:transparent;stroke:#ff1fa8;stroke-width:3px;overflow:visible}.bank-card__glare{width:100%;height:100%;background:linear-gradient( 125deg, 
        rgba(255,255,255,0) 10%,
        rgba(255,255,255,0.5) 45%,
        rgba(255,255,255,0) 45%,
        rgba(255,255,255,0) 115% 
      );background-size:150% 150%;background-position-x:var(--pointer-x);background-position-y:var(--pointer-y);background-repeat:no-repeat;mix-blend-mode:plus-lighter;z-index:5;opacity:0.25}.bank-card__texture{width:100%;height:100%;background:var(--img_TEXTURE);background-size:cover;background-repeat:no-repeat;mix-blend-mode:multiply;opacity:0.15;z-index:3}.bank-card__chip{position:absolute;left:12%;top:35%;display:grid;place-items:center;width:14%;aspect-ratio:5/4;border-radius:10% 10% 10% 10% / 15% 15% 15% 15%;background-image:radial-gradient( rgba(255, 255, 255, 0.493), black ),
      linear-gradient(120deg, #ae8625 10%, #f7ef8a 40%, #d2ac47 70%, #edc967 90%);background-size:200% 200%;background-position-x:center, var(--pointer-x);background-position-y:center, var(--pointer-y);background-blend-mode:overlay;box-shadow:calc(2px * var(--pointer-from-left) - 1px) calc(3px * var(--pointer-from-top) - 1px) 1px rgba(0,0,0,0.33);overflow:hidden;z-index:4}.bank-card__number{color:#fff;position:absolute;bottom:31%;margin:0;padding:0;letter-spacing:0.125em;word-spacing:.5em;text-transform:uppercase;font-size:clamp(0.75rem, 4vw + 0.2rem, 2.5rem);filter:drop-shadow(calc(2px * var(--pointer-from-left) - 1px) calc(3px * var(--pointer-from-top) - 1px) 1px rgba(0,0,0,0.33));z-index:4}.bank-card__master,.bank-card__world{position:absolute;right:5%;top:5%;width:15%;-webkit-mask-image:linear-gradient(125deg, hsla(0, 0%, 25%, 0.6) 33%, hsla(0, 0%, 100%, 1), hsla(0, 0%, 0%, 0.4) 66%);mask-image:linear-gradient(125deg, hsla(0, 0%, 25%, 0.6) 33%, hsla(0, 0%, 100%, 1), hsla(0, 0%, 0%, 0.4) 66%);-webkit-mask-size:200% 200%;mask-size:200% 200%;-webkit-mask-position:var(--pointer-x) var(--pointer-y);mask-position:var(--pointer-x) var(--pointer-y);-webkit-mask-repeat:no-repeat;mask-repeat:no-repeat;filter:invert(1) saturate(0) brightness(1.3) contrast(1.2);mix-blend-mode:normal;z-index:6}.bank-card__world{display:grid;place-items:center;right:auto;left:5%;width:15%;height:15%;mask:none;background-image:conic-gradient( from calc((var(--rotate-x) + var(--rotate-y)) / 2), rgba(171, 202, 223, 0.4), hsla(0, 0%, 0%, 0.35), rgba(171, 202, 223, 0.4), hsla(0, 0%, 0%, 0.35), rgba(171, 202, 223, 0.4), hsla(0, 0%, 0%, 0.35), rgba(171, 202, 223, 0.4)), 
      linear-gradient(125deg, hsla(0, 0%, 25%, 0.6), rgb(171, 202, 223), hsla(0, 0%, 0%, 0.4));background-size:200% 200%;background-position:center center, var(--pointer-x) var(--pointer-y);background-blend-mode:overlay;filter:saturate(1.2) brightness(1.2) contrast(1.8);border-radius:100px}.bank-card__world svg{width:88%;fill:rgb(138, 108, 204);mix-blend-mode:difference;opacity:0.6;filter:hue-rotate(calc(180deg * (var(--pointer-from-left) + var(--pointer-from-top)) + 180deg));-webkit-mask-image:linear-gradient(225deg, hsla(0, 0%, 25%, 0.5) 33%, hsla(0, 0%, 100%, 0.9), hsla(0, 0%, 0%, 0.3) 66%);mask-image:linear-gradient(225deg, hsla(0, 0%, 25%, 0.5) 33%, hsla(0, 0%, 100%, 0.9), hsla(0, 0%, 0%, 0.3) 66%);-webkit-mask-size:200% 200%;mask-size:200% 200%;-webkit-mask-position:var(--pointer-x) var(--pointer-y);mask-position:var(--pointer-x) var(--pointer-y);-webkit-mask-repeat:no-repeat;mask-repeat:no-repeat}.bank-card__chip svg{display:block;width:90%;fill:none;stroke:#a69278;stroke-width:2;mix-blend-mode:color-burn}.bank-card__contactless{position:absolute;left:24%;top:34.5%;display:grid;place-items:center;width:14%;aspect-ratio:5/4;transform:translateX(calc( 0px + (var(--pointer-from-left) - 0.5) * var(--logo-3d-distance) )) 
      translateY(calc( 0px + (var(--pointer-from-top) - 0.5) * var(--logo-3d-distance) )) 
      translateZ(0.1px)
      rotate(90deg);z-index:4}.bank-card__contactless svg{display:block;width:90%;fill:none;stroke:#a69278;stroke-width:2;mix-blend-mode:color-burn;fill:none;stroke:white;stroke-linecap:round}.bank-card__chip,.bank-card__master,.bank-card__number,.bank-card__world,.bank-card__logo,.bank-card__logo-outline,.bank-card__shine{transform:translateX(calc( 0px + (var(--pointer-from-left) - 0.5) * var(--logo-3d-distance) )) 
      translateY(calc( 0px + (var(--pointer-from-top) - 0.5) * var(--logo-3d-distance) )) 
      translateZ(0.1px)}#chip,#contactless,#bank-text,#world{display:none}button.bank-rotator{border:none;padding:0;-webkit-appearance:none;appearance:none}`;

    		this.shadowRoot.appendChild(style);

    		init(
    			this,
    			{
    				target: this.shadowRoot,
    				props: attribute_to_object(this.attributes),
    				customElement: true
    			},
    			instance,
    			create_fragment,
    			safe_not_equal,
    			{},
    			null
    		);

    		if (options) {
    			if (options.target) {
    				insert(options.target, this, options.anchor);
    			}
    		}
    	}
    }

    customElements.define("bank-card", Card);

    return Card;

}));
