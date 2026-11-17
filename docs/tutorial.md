# Redpen tutorial

[中文版](tutorial.zh-CN.md)

This walks you through one complete round on the demo deck: mark it up, hand it to an agent, read the replies.
It takes about ten minutes. After that come the things you will want for your own files: generated files, LaTeX
papers, posters, and the iPad.

The review page comes in English and Chinese. It follows your browser's language; the button at the right end of
the toolbar (**中文** / **EN**) switches it. This tutorial uses the English labels.

## 1. Open the demo deck

You need Python 3 and a coding agent that can read and edit files on your computer (Claude Code, Codex, Cursor
and similar).

```bash
git clone https://github.com/Sijie-Yang/redpen.git
```

```bash
python3 redpen/review.py redpen/examples/demo-deck.html
```

The terminal prints the address and your browser opens it. Leave the terminal running; Ctrl+C stops the server
when you are done.

The demo deck has five slides about bike lanes and coffee. Three things are wrong with it on purpose: a typo on
slide 2, a 55-word sentence on slide 2, and a chart on slide 3 that is too small to read.

## 2. The page

The document is on the left, exactly as it normally looks. Your notes are on the right. The tools are on top.

![The review page](../assets/screenshot-annotate-en.png)

**Toolbar**

| Tool | Key | What it does |
|---|---|---|
| Browse | `V` | Nothing is added when you click. You can still select text to comment on it |
| Pin | `C` | Click anywhere to leave a comment at that point |
| Box | `R` | Drag a rectangle around a region |
| Sentence | `T` | Click a sentence to select all of it |
| Element | `E` | Click a figure, a table or a paragraph to select the whole thing |
| Edit | `W` | Retype text in place (HTML only) |
| Pen | `P` | Draw freehand |
| Arrow | `A` | Drag from one place to another |
| Laser | `L` | Laser pointer, for presenting. Leaves no note |
| Image | `I` | Add an image file to this page |
| Paste | `⌘V` / `Ctrl+V` | Paste a screenshot onto this page |
| Present | `F` | Present full screen |
| Sidebar, Help | | Show or hide the sidebar; open the help |
| 中文 / EN | | Switch the interface between Chinese and English. The choice is remembered |

`←` and `→` turn pages. `Esc` goes back to browsing. `⌘Z` / `Ctrl+Z` undoes.

**Sidebar**

- **This page / All / Previous round**: the notes on this page; all notes, next to an outline of the deck; the previous
  round with the agent's replies.
- **Page comment**: a comment on the whole slide. **Add page before / Add page after / Move / Delete**: change the
  deck itself. **Speaker notes**: rewrite the speaker notes of this slide.
- **More…**: do not touch this page, split it in two, merge it with the next, move it to backup, skip it in the short
  version, duplicate it and change the copy.
- On the card of each note: the kind of note (Comment, Change text, Add / replace image, Layout, Delete, Other), ★
  (important: the agent does these first), **Change to** (the new wording, if you already know it), your comment, the
  small purple buttons (one-click comments), **＋ Image** (attach a picture to this note) and **All pages** (apply
  this note to every page).
- At the bottom: **Copy for AI** (the instruction for your agent), **Copy notes** (the notes as plain text) and
  **Archive** (close this round and start clean, without an agent).

## 3. Fix a typo

Press `→` to go to slide 2. Press `T`, then click the sentence that begins "Cafés recieve many short visits".

The sentence is highlighted and a card appears on the right. Type your comment into the large box:

> Typo: recieve → receive

If you would rather give the exact new wording, type it into **Change to** instead. The agent then uses it verbatim.

There is no save button. The green line at the bottom tells you how many notes have been saved.

## 4. Shorten a sentence with one click

Still on slide 2 and still in the sentence tool, click the long third bullet. On its card, click the small button
**Too long, shorten**. Then click the **★** on the card to mark it as important.

![Two notes on text](../assets/screenshot-text-en.png)

Press `Esc` to leave the sentence tool.

## 5. Point at a figure

Go to slide 3. Press `E` and click the chart. The whole chart gets a frame and a number. Write:

> Too small to read. Make the chart fill the left half of the slide.

`E` picks the innermost element under the pointer. If it picks too little, click **Select parent** on the card to
step up to the element around it.

## 6. Draw

Press `P` and underline the second bullet with the mouse (or with a Pencil on an iPad). Strokes made within a
short time count as one note. Write what the stroke means:

> Simpler: "twelve weeks in total"

A stroke on its own is ambiguous, so a few words help. As a rule of thumb, agents read a line through text as
"delete" and a circle as "this one".

Press `Esc`.

## 7. Three more things worth trying

**Show, don't tell.** Take a screenshot of anything (a figure from a paper, another slide you like) and press
`⌘V` / `Ctrl+V`. The picture lands on the page. Drag it to where you want it and resize it. On its card, choose
whether the agent should place it here, use it to replace the image underneath, or treat it only as a reference
for what you want.

**Change the deck.** On slide 4, click **Add page after**, give the new slide a title, pick a layout and say in a
sentence what should be on it.

**Rewrite speaker notes.** Click **Speaker notes** and edit the text. The agent receives the full new text.

Then open the tab **All** to see every note in one list, next to an outline of the deck.

## 8. Hand it to your agent

Click **Copy for AI** at the bottom right and paste into your agent. It does not matter which project or
conversation the agent is in: the instruction contains the full paths of the file, the notes and the rules.

The pasted text looks like this:

> Please apply the notes I left in the review tool (Redpen) to: /…/demo-deck.html
>
> 1. Read the list of notes first: /…/demo-deck.html.review/annotations.md
> 2. For coordinates, target elements or images, look in: /…/annotations.json
> 3. First find out whether this file is hand-written or generated from another source file; edit the source
> 4. Rules and data format: /…/redpen/AGENTS.md
> 5. When you are done, write a status and a reply on each note in annotations.json, then run: `review.py archive …`

You can also simply say "apply my review notes on demo-deck.html following redpen/AGENTS.md".

The agent now:

1. reads `annotations.md`, and `annotations.json` where it needs exact data;
2. opens every picture you attached;
3. edits the source, important notes first, and rebuilds if there is a build step;
4. writes on every note whether it is done, partly done or skipped, with one sentence of explanation;
5. archives the round.

## 9. Read the replies

Keep the review page open while the agent works. A few seconds after it archives the round, the page empties
itself, offers to reload the changed file, and the tab **Previous round** shows each of your notes with the agent's
reply: Done, Partly done or Not done, and why.

You can keep marking up while the agent works. A note it did not get to is not archived with the round: it stays on
the page for the next one.

![Replies after the round](../assets/screenshot-replies-en.png)

If something is still not right, mark it up again and hand over again. Each round is kept in
`demo-deck.html.review/archive/`.

That is the whole loop.

## 10. Your own files

### A file that is generated from something else

Most real documents are built: a PDF from LaTeX, a deck from a template, a figure from a plotting script. Tell
Redpen once what to edit and how to rebuild. It stores this in the review folder and includes it in every
instruction from then on.

```bash
python3 redpen/review.py talk.html --source slides.md --build "python3 build.py"
```

### A LaTeX paper

```bash
python3 redpen/review.py paper.pdf --source paper.tex --build "latexmk -pdf -synctex=1 paper.tex"
```

PDFs need poppler (`brew install poppler`, or `apt install poppler-utils`). You can select sentences in the PDF
just as in HTML. If the PDF was compiled with `-synctex=1` and the `synctex` command is available (it comes with
TeX Live and MacTeX), each note carries the `.tex` file and line it refers to, so the agent goes straight there,
also in a paper split over many files.

### A poster or a report (one long HTML page)

Redpen decides by itself whether an HTML file is a deck or a single page. If it guesses wrong:

```bash
python3 redpen/review.py poster.html --page
```

```bash
python3 redpen/review.py talk.html --slides "section.slide"
```

### Figures

A single image, or a folder of images, each shown as one page:

```bash
python3 redpen/review.py figures/
```

Remember that an agent cannot edit a PNG. Tell it where the plotting script is with `--source`.

### PowerPoint and Keynote

Export to PDF and review the PDF. The page number is the slide number.

## 11. iPad

**Live.** Start with `--lan` and open the printed link in Safari on the iPad. Both devices must be on the same
network (the same Wi-Fi, or Tailscale).

```bash
python3 redpen/review.py paper.pdf --lan
```

With an Apple Pencil you do not pick a tool: the Pencil draws, your finger scrolls. Everything is saved on the
computer, so you can sit down at it afterwards, type comments next to your strokes and hand over.

**Offline.** Annotate the PDF by hand in any app, on a plane if you like. Send the annotated copy back to the
computer under a different name, so that you still have the untouched original. Then tell your agent:

> I annotated paper.pdf on my iPad. The annotated copy is paper-marked.pdf. Apply my notes.

It runs `review.py import paper.pdf paper-marked.pdf` (this needs `pip install pillow numpy`), which finds
everything you wrote by comparing the two files, and then reads your handwriting from the crops.

Two things to keep in mind: write on the page itself, not in pop-up sticky notes (their text is not on the page,
so it cannot be found), and for an HTML deck annotate its PDF export.

## 12. When something goes wrong

| Problem | What to do |
|---|---|
| The deck shows as one long page, or the page count is wrong | Give the selector of one slide: `--slides "<css>"` |
| Speaker notes or slide titles are not found | `--notes "<css>"`, `--title "<css>"` |
| Images or styles are missing in the HTML | The HTML loads files from a parent folder. Serve that folder: `--root ..` |
| "pdftoppm" is missing | Install poppler |
| No `.tex` line numbers | Compile with `-synctex=1` and keep the `.synctex.gz` file next to the PDF |
| The port is taken | Redpen tries the next 30 ports by itself, or choose one with `--port` |
| Notes seem to be gone | Nothing is ever deleted. Look in `<file>.review/history/` and `archive/` |
| You want to start over without an agent | **Archive** at the bottom right |
| The page is in the wrong language | Click **EN** or **中文** at the right end of the toolbar, or start with `--lang en` |
| The iPad cannot open the link | Check that both devices are on the same network and that you used the full link with `?k=…` |

## 13. Good habits

- Write notes the way you would for a colleague: say what is wrong or what you want, not only "fix".
- Use ★ sparingly, for the notes that must not be missed.
- One round, one batch. It is quicker to mark up twenty things and hand over once than to go back and forth.
- Read the replies. An honest agent says "skipped, because…" when a note was unclear, and that is your next round.
