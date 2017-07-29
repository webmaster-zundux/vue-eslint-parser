/**
 * @author Toru Nagashima <https://github.com/mysticatea>
 * @copyright 2017 Toru Nagashima. All rights reserved.
 * See LICENSE file in root directory for full license.
 */
import assert from "assert"
import * as lodash from "lodash"
import {debug} from "../common/debug"
import {ErrorCode, HasLocation, Namespace, NS, ParseError, Token, VAttribute, VDocumentFragment, VElement} from "../ast"
import {MATHML_ATTRIBUTE_NAME_MAP, SVG_ATTRIBUTE_NAME_MAP} from "./util/attribute-names"
import {HTML_CAN_BE_LEFT_OPEN_TAGS, HTML_NON_FHRASING_TAGS, HTML_RAWTEXT_TAGS, HTML_RCDATA_TAGS, HTML_VOID_ELEMENT_TAGS, SVG_ELEMENT_NAME_MAP} from "./util/tag-names"
import {IntermediateToken, IntermediateTokenizer, EndTag, StartTag, Text} from "./intermediate-tokenizer"
import {Tokenizer} from "./tokenizer"

const DUMMY_PARENT: any = Object.freeze({})

/**
 * Check whether the element is a MathML text integration point or not.
 * @see https://html.spec.whatwg.org/multipage/parsing.html#tree-construction-dispatcher
 * @param element The current element.
 * @returns `true` if the element is a MathML text integration point.
 */
function isMathMLIntegrationPoint(element: VElement): boolean {
    if (element.namespace === NS.MathML) {
        const name = element.name
        return name === "mi" || name === "mo" || name === "mn" || name === "ms" || name === "mtext"
    }
    return false
}

/**
 * Check whether the element is a HTML integration point or not.
 * @see https://html.spec.whatwg.org/multipage/parsing.html#tree-construction-dispatcher
 * @param element The current element.
 * @returns `true` if the element is a HTML integration point.
 */
function isHTMLIntegrationPoint(element: VElement): boolean {
    if (element.namespace === NS.MathML) {
        return (
            element.name === "annotation-xml" &&
            element.startTag.attributes.some(a =>
                a.directive === false &&
                a.key.name === "encoding" &&
                a.value != null &&
                (
                    a.value.value === "text/html" ||
                    a.value.value === "application/xhtml+xml"
                )
            )
        )
    }
    if (element.namespace === NS.SVG) {
        const name = element.name
        return name === "foreignObject" || name === "desc" || name === "title"
    }

    return false
}

/**
 * Adjust element names by the current namespace.
 * @param name The lowercase element name to adjust.
 * @param namespace The current namespace.
 * @returns The adjusted element name.
 */
function adjustElementName(name: string, namespace: Namespace): string {
    if (namespace === NS.SVG) {
        return SVG_ELEMENT_NAME_MAP.get(name) || name
    }
    return name
}

/**
 * Adjust attribute names by the current namespace.
 * @param name The lowercase attribute name to adjust.
 * @param namespace The current namespace.
 * @returns The adjusted attribute name.
 */
function adjustAttributeName(name: string, namespace: Namespace): string {
    if (namespace === NS.SVG) {
        return SVG_ATTRIBUTE_NAME_MAP.get(name) || name
    }
    if (namespace === NS.MathML) {
        return MATHML_ATTRIBUTE_NAME_MAP.get(name) || name
    }
    return name
}

/**
 * Set the location of the last child node to the end location of the given node.
 * @param node The node to commit the end location.
 */
function propagateEndLocation(node: VDocumentFragment | VElement): void {
    const lastChild = (node.type === "VElement" ? node.endTag : null) || lodash.last(node.children)
    if (lastChild != null) {
        node.range[1] = lastChild.range[1]
        node.loc.end = lastChild.loc.end
    }
}

/**
 * The parser of HTML.
 * This is not following to the HTML spec completely because Vue.js template spec is pretty different to HTML.
 */
export class Parser {
    private tokenizer: IntermediateTokenizer
    private document: VDocumentFragment
    private elementStack: VElement[]

    /**
     * The tokens.
     */
    private get tokens(): Token[] {
        return this.tokenizer.tokens
    }

    /**
     * The comments.
     */
    private get comments(): Token[] {
        return this.tokenizer.comments
    }

    /**
     * The syntax errors which are found in this parsing.
     */
    private get errors(): ParseError[] {
        return this.tokenizer.errors
    }

    /**
     * The current namespace.
     */
    private get namespace(): Namespace {
        return this.tokenizer.namespace
    }
    private set namespace(value: Namespace) { //eslint-disable-line require-jsdoc
        this.tokenizer.namespace = value
    }

    /**
     * The current flag of expression enabled.
     */
    private get expressionEnabled(): boolean {
        return this.tokenizer.expressionEnabled
    }
    private set expressionEnabled(value: boolean) { //eslint-disable-line require-jsdoc
        this.tokenizer.expressionEnabled = value
    }

    /**
     * Get the current node.
     */
    private get currentNode(): VDocumentFragment | VElement {
        return lodash.last(this.elementStack) || this.document
    }

    /**
     * Initialize this parser.
     * @param tokenizer The tokenizer to parse.
     * @param postprocess The callback function to postprocess nodes.
     */
    constructor(tokenizer: Tokenizer) {
        this.tokenizer = new IntermediateTokenizer(tokenizer)
        this.document = {
            type: "VDocumentFragment",
            range: [0, 0],
            loc: {
                start: {line: 1, column: 0},
                end: {line: 1, column: 0},
            },
            parent: null,
            children: [],
            tokens: this.tokens,
            comments: this.comments,
            errors: this.errors,
        }
        this.elementStack = []
    }

    /**
     * Parse the HTML which was given in this constructor.
     * @returns The result of parsing.
     */
    parse(): VDocumentFragment {
        let token: IntermediateToken | null = null
        while ((token = this.tokenizer.nextToken()) != null) {
            (this as any)[token.type](token)
        }

        this.popElementStackUntil(0)
        propagateEndLocation(this.document)

        return this.document
    }

    /**
     * Report an invalid character error.
     * @param code The error code.
     */
    private reportParseError(token: HasLocation, code: ErrorCode): void {
        const error = ParseError.fromCode(code, token.range[0], token.loc.start.line, token.loc.start.column)
        this.errors.push(error)

        debug("[html] syntax error:", error.message)
    }

    /**
     * Pop an element from the current element stack.
     */
    private popElementStack(): void {
        assert(this.elementStack.length >= 1)

        const element = this.elementStack.pop() as VElement
        propagateEndLocation(element)

        // Update the current namespace.
        const current = this.currentNode
        this.namespace = (current.type === "VElement") ? current.namespace : NS.HTML

        // Update expression flag.
        if (this.elementStack.length === 0) {
            this.expressionEnabled = false
        }
    }

    /**
     * Pop elements from the current element stack.
     * @param index The index of the element you want to pop.
     */
    private popElementStackUntil(index: number): void {
        while (this.elementStack.length > index) {
            this.popElementStack()
        }
    }

    /**
     * Detect the namespace of the new element.
     * @param name The value of a HTMLTagOpen token.
     * @returns The namespace of the new element.
     */
    private detectNamespace(name: string): Namespace {
        let ns = this.namespace

        if (ns === NS.MathML || ns === NS.SVG) {
            const element = this.currentNode
            if (element.type === "VElement") {
                if (element.namespace === NS.MathML && element.name === "annotation-xml" && name === "svg") {
                    return NS.SVG
                }
                if (isHTMLIntegrationPoint(element) || (isMathMLIntegrationPoint(element) && name !== "mglyph" && name !== "malignmark")) {
                    ns = NS.HTML
                }
            }
        }

        if (ns === NS.HTML) {
            if (name === "svg") {
                return NS.SVG
            }
            if (name === "math") {
                return NS.MathML
            }
        }

        return ns
    }

    /**
     * Close the current element if necessary.
     * @param name The tag name to check.
     */
    private closeCurrentElementIfNecessary(name: string): void {
        const element = this.currentNode
        if (element.type !== "VElement") {
            return
        }

        if (element.name === "p" && HTML_NON_FHRASING_TAGS.has(name)) {
            this.popElementStack()
        }
        if (element.name === name && HTML_CAN_BE_LEFT_OPEN_TAGS.has(name)) {
            this.popElementStack()
        }
    }

    /**
     * Adjust and validate the given attribute node.
     * @param node The attribute node to handle.
     * @param namespace The current namespace.
     */
    private handleAttribute(node: VAttribute, namespace: Namespace): void {
        const key = node.key.name = adjustAttributeName(node.key.name, namespace)
        const value = node.value && node.value.value

        if (key === "xmlns" && value !== namespace) {
            this.reportParseError(node, "x-invalid-namespace")
        }
        else if (key === "xmlns:xlink" && value !== NS.XLink) {
            this.reportParseError(node, "x-invalid-namespace")
        }
    }

    /**
     * Handle the start tag token.
     * @param token The token to handle.
     */
    protected StartTag(token: StartTag): void {
        debug("[html] StartTag %j", token)

        this.closeCurrentElementIfNecessary(token.name)

        const parent = this.currentNode
        const namespace = this.detectNamespace(token.name)
        const element: VElement = {
            type: "VElement",
            range: [token.range[0], token.range[1]],
            loc: {start: token.loc.start, end: token.loc.end},
            parent,
            name: adjustElementName(token.name, namespace),
            namespace,
            startTag: {
                type: "VStartTag",
                range: [token.range[0], token.range[1]],
                loc: {start: token.loc.start, end: token.loc.end},
                parent: DUMMY_PARENT,
                attributes: token.attributes,
            },
            children: [],
            endTag: null,
            variables: [],
        }

        // Setup relations.
        for (const attribute of token.attributes) {
            attribute.parent = element.startTag
            this.handleAttribute(attribute, namespace)
        }
        element.startTag.parent = element
        parent.children.push(element)

        // Check whether the self-closing is valid.
        const isVoid = (namespace === NS.HTML && HTML_VOID_ELEMENT_TAGS.has(element.name))
        if (token.selfClosing && !isVoid && namespace === NS.HTML) {
            this.reportParseError(token, "non-void-html-element-start-tag-with-trailing-solidus")
        }

        // Vue.js supports self-closing elements even if it's not one of void elements.
        if (token.selfClosing || isVoid) {
            return
        }

        // Push to stack.
        this.elementStack.push(element)
        this.namespace = namespace

        // Update the content type of this element.
        if (namespace === NS.HTML) {
            if (element.name === "template" && element.parent.type === "VDocumentFragment") {
                const langAttr = element.startTag.attributes.find(a => !a.directive && a.key.name === "lang") as (VAttribute | undefined)
                const lang = (langAttr && langAttr.value && langAttr.value.value) || "html"

                if (lang !== "html") {
                    this.tokenizer.state = "RAWTEXT"
                }
                this.expressionEnabled = true
            }
            if (HTML_RCDATA_TAGS.has(element.name)) {
                this.tokenizer.state = "RCDATA"
            }
            if (HTML_RAWTEXT_TAGS.has(element.name)) {
                this.tokenizer.state = "RAWTEXT"
            }
        }
    }

    /**
     * Handle the end tag token.
     * @param token The token to handle.
     */
    protected EndTag(token: EndTag): void {
        debug("[html] EndTag %j", token)

        const i = lodash.findLastIndex(this.elementStack, (el) =>
            el.name.toLowerCase() === token.name
        )
        if (i === -1) {
            this.reportParseError(token, "x-invalid-end-tag")
            return
        }

        const element = this.elementStack[i]
        element.endTag = {
            type: "VEndTag",
            range: token.range,
            loc: token.loc,
            parent: element,
        }

        this.popElementStackUntil(i)
    }

    /**
     * Handle the text token.
     * @param token The token to handle.
     */
    protected Text(token: Text): void {
        debug("[html] Text %j", token)

        const parent = this.currentNode
        parent.children.push({
            type: "VText",
            range: token.range,
            loc: token.loc,
            parent,
            value: token.value,
        })
    }
}
