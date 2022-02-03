#!/usr/bin/env node
import fs from "fs";
import { Stream } from "stream";
import path from "path";
import {
    default as cheerio,
    CheerioAPI
} from "cheerio";
import YAML from "yaml";
import {
    request,
    GaxiosResponse
} from "gaxios";
import { google } from "googleapis";
import { OAuth2Client } from "google-auth-library";
import {
    registerPrompt,
    prompt
} from "inquirer";
import OrderList from "inquirer-order-list";

registerPrompt("order-list", OrderList);

const FOLDER_REGEXP = new RegExp("https://drive.google.com/drive/folders/(.*)");

const SCOPES = [
    "https://www.googleapis.com/auth/drive.readonly"
];

interface Page {
    url: string;
    remove?: string;
    frontpage?: string;
    script?: string;
    style?: string;
}

interface Article {
    title: string;
    href?: string;
    subtitle?: string;
    image?: string;
    author?: string;
}

interface FullArticle extends Article {
    body: string;
}

type ArticleList = Record<string, Article | string | null>;
const normalize = (articles: ArticleList): Record<string, Article> => {
    const normalized: Record<string, Article> = {};
    for (let [ key, value ] of Object.entries(articles)) {
        if (value === null) {
            normalized[key] = {
                title: ""
            };
        } else if (typeof value === "string" || (value instanceof String && !("title" in value))) {
            normalized[key] = {
                title: value
            };
        } else {
            normalized[key] = value;
        }
    }
    return normalized;
};

interface Configuration {
    frontpage: Page & {
        articles: ArticleList;
    };
    article: Page & FullArticle & {
        links: ArticleList;
	suffix?: string;
    };
    default?: string;
    authors?: string[];
}

interface SavedCredentials {
    installed: {
        client_secret: string;
        client_id: string;
        redirect_uris: string[];
    };
}

if (process.argv.length !== (2 + 4)) {
    console.error(`Usage: ${process.argv.join(" ")} <siteconfig.yaml> <client_secret.json> <docs> <output>

Arguments:
    siteconfig.yaml: Configuration to spoof a particular media outlet. See the README.org file for documentation.
    client_secret.json: OAuth client secret downloaded from Google Clould Console.
    docs: Google Drive folder ID with parody articles.
    output: Directory in which to store static parody site.`);
    process.exit(1);
}

const unwrap = <T>(res: GaxiosResponse<T>): T => {
    if (res.status !== 200) {
        throw `Received status ${res.status} while trying to access ${res.request.responseURL}`;
    }
    return res.data;
};

const mkdir = (dir: string) => fs.existsSync(dir) || fs.mkdirSync(dir);

const safeName = (str: string): string => str.toLowerCase().replace(/[^a-z0-9]/g, "-");

let authorIndex: number = 0;
const assignedAuthors: Record<string, string[]> = {};
const getAuthor = (authors: string[] | undefined, article: FullArticle, authorNumber: number): string => {
    (article.title in assignedAuthors) || (assignedAuthors[article.title] = []);
    return assignedAuthors[article.title][authorNumber] = assignedAuthors[article.title][authorNumber]
	?? authors?.[authorIndex++ % (authors?.length ?? 1)]
	?? "Crimzoid";
}

const getPage = async (page: Page): Promise<CheerioAPI> => {
    const $ = cheerio.load(unwrap(await request({
        url: page.url,
        responseType: "text"
    })));
    $("script").remove();
    page.remove && $(page.remove).remove();
    page.script && $("body").append($(`<script>${page.script}</script>`));
    page.style && $("head").append($(`<style>${page.style}</style>`));
    return $;
};

const processArticles = ($: CheerioAPI,
			 config: Record<string, Article>,
			 articles: FullArticle[],
			 authors: string[] | undefined,
			 articlesFolder: string,
			 imagesFolder: string): CheerioAPI => {
    let i: number = 0;
    for (let [ selector, article ] of Object.entries(config)) {
	i < articles.length && $(selector).each((i: number, element) => {
            let title = $(element);
            if (article.title) {
		title = title.find(article.title);
            }
            title.text(articles[i].title);
            let href = $(element);
            if (article.href) {
		href = href.find(article.href);
            }
            href.attr("href", articlesFolder + "/" + safeName(articles[i].title) + ".html");
            if (article.image) {
		const image = $(element).find(article.image);
		if (articles[i].image) {
                    image.replaceWith(`<img src="${imagesFolder}/${articles[i].image}" />`);
		} else {
                    image.remove();
		}
            }
            if (article.subtitle) {
		$(element).find(article.subtitle).text(articles[i].subtitle ?? "");
            }
	    if (article.author) {
		$(element).find(article.author).each((j: number, element) => {
		    $(element).text(getAuthor(authors, articles[i], j));
		    return true;
		});
	    }
            i++;
            return i < articles.length;
	});
	i < articles.length || $(selector).remove();
    }
    return $;
};

const auth = async ({ installed: credentials }: SavedCredentials) => {
    const oAuth2Client: OAuth2Client = new google.auth.OAuth2(credentials.client_id, credentials.client_secret, credentials.redirect_uris[0]);
    console.log(`Login here with an account that has access to the docs: ` + oAuth2Client.generateAuthUrl({
        access_type: "offline",
        scope: SCOPES
    }));
    const { code } = await prompt([{
        type: "password",
        message: "Enter the code from that page here: ",
        name: "code",
        mask: "*"
    }]);
    oAuth2Client.setCredentials((await oAuth2Client.getToken(code)).tokens);
    return oAuth2Client;
}

const save = async (folder: string, basename: string, url?: string | null): Promise<string | undefined> => {
    if (!url) {
        return undefined;
    }
    const res = await request<Stream>({
        url,
        responseType: "stream"
    });
    if (res.status === 200) {
        const filename = basename + "." + res.headers["content-type"].split("/")[1]; // Poor man's MIME type to extension conversion.
        res.data.pipe(fs.createWriteStream(path.join(folder, filename)));
        return filename;
    } else {
        console.error(`Received status ${res.status} while trying to access ${url}`);
        return undefined;
    }
};

const spoof = async (config: Configuration, oAuth2Client: OAuth2Client, docsUrl: string, output: string) => {
    const drive = google.drive({
        version: "v3",
        auth: oAuth2Client
    });
    const docs = google.docs({
        version: "v1",
        auth: oAuth2Client
    });
    const folder = FOLDER_REGEXP.exec(docsUrl)?.[1];
    if (!folder) {
        throw docsUrl + " is not a valid Google Drive folder URL";
    }
    const articleMap: Record<string, FullArticle> = {};
    mkdir(output)
    mkdir(path.join(output, "articles"));
    mkdir(path.join(output, "images"));
    const files = unwrap(await drive.files.list({
        pageSize: 1000,
        q: `'${folder}' in parents and mimeType = 'application/vnd.google-apps.document'`,
        fields: "files(id, name)"
    })).files;
    if (!files) {
	throw "No docs in folder";
    }
    const articles: FullArticle[] = (await Promise.all(new Array<Promise<{ priority: string[] }>>(prompt([{
        type: "order-list",
        message: "Order parody articles by priority, most important first: ",
        name: "priority",
        choices: files.map(({ id, name }) => ({
	    name,
	    value: id
        }))
    }])).concat(files.map(async ({ id, name }): Promise<{ priority: string[] }> => {
	if (!id || !name) {
	    return { priority: [] };
	}
        const document = unwrap(await docs.documents.get({
	    documentId: id
        }));
        let body = "";
        for (let { paragraph } of document?.body?.content ?? []) {
	    if (!paragraph?.elements) {
                continue;
	    }
	    for (let { textRun } of paragraph?.elements) {
                const text = textRun?.content;
                if (!text || text.trim().toUpperCase() == name.toUpperCase()) {
		    continue;
                }
                body += text;
	    }
        }
	body = body.trim();
	articleMap[id] = {
	    title: name,
	    subtitle: body.split("\n")[0],
	    body: body,
	    image: await save(path.join(output, "images"), safeName(name),
			      Object.values(document.inlineObjects ?? {})[0]?.inlineObjectProperties?.embeddedObject?.imageProperties?.contentUri
                || Object.values(document.positionedObjects ?? {})[0]?.positionedObjectProperties?.embeddedObject?.imageProperties?.contentUri)
        };
	return { priority: [] };
    }))))[0].priority.map(id => articleMap[id]);
    const frontpage = await getPage(config.frontpage);
    config.default && frontpage("a").attr("href", config.default);
    config.frontpage.frontpage && frontpage(config.frontpage.frontpage).attr("href", "#");
    fs.writeFileSync(path.join(output, "index.html"),
		     processArticles(frontpage,
				     normalize(config.frontpage.articles),
				     articles,
				     config.authors,
				     "./articles",
				     "./images").html());
    let articlePage = await getPage(config.article);
    config.default && articlePage("a").attr("href", config.default);
    config.article.frontpage && articlePage(config.article.frontpage).attr("href", "../");
    articlePage = processArticles(articlePage,
				  normalize(config.article.links),
				  articles,
				  config.authors,
				  "./",
				  "../images");
    for (let article of articles) {
	articlePage(config.article.title).text(article.title);
	articlePage(config.article.body).text(article.body);
	if (config.article.subtitle) {
	    articlePage(config.article.subtitle).text(article.subtitle ?? "");
	}
	if (config.article.image) {
	    if (article.image) {
		articlePage(config.article.image).add("#spoof-image").replaceWith(`<img id="spoof-image" src="../images/${article.image}" />`);
	    } else {
		articlePage(config.article.image).add("#spoof-image").remove();
	    }
	}
	if (config.article.author) {
	    articlePage(config.article.author).each((j: number, element) => {
		articlePage(element).text(getAuthor(config.authors, article, j));
		return true;
	    });
	}
	articlePage("title").text(article.title + (config.article.suffix ?? ""));
	fs.writeFileSync(path.join(output, "articles", safeName(article.title) + ".html"), articlePage.html());
    }
};
if (require.main === module) {
    const config: Configuration = YAML.parse(fs.readFileSync(process.argv[2], "utf8"));
    auth(JSON.parse(fs.readFileSync(process.argv[3], "utf8")) as SavedCredentials)
        .then(oAuth2Client => spoof(config, oAuth2Client, process.argv[4], process.argv[5]))
        .catch(error => console.error(error));
}
