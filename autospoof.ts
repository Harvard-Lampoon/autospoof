#!/usr/bin/env ts-node-transpile-only
import fs from "fs";
import {
    default as stream,
    Stream
} from "stream";
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
    script?: string;
    css?: Record<string, Record<string, string>>;
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

const getPage = async (page: Page): Promise<CheerioAPI> => {
    const $ = cheerio.load(unwrap(await request({
        url: page.url,
        responseType: "text"
    })));
    $("script").remove();
    $(page.remove).remove();
    for (let [ selector, css ] of Object.entries(page.css ?? {})) {
        $(selector).css(css);
    }
    page.script && $("body").append($("<script>${page.script}</script>"));
    return $;
};

const processArticles = ($: CheerioAPI, config: Record<string, Article>, articles: FullArticle[], articlesFolder: string, imagesFolder: string): CheerioAPI => {
    let i: number = 0;
    for (let [ selector, article ] of Object.entries(config)) {
        if (i < articles.length) {
            $(selector).each((i: number, element) => {
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
                i++;
                return i < articles.length;
            });
        }
        if (i >= articles.length) {
            $(selector).remove();
        }
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
        const filename = basename +  + "." + res.headers["content-type"].split("/")[1]; // Poor man's MIME type to extension conversion.
        const writeStream = fs.createWriteStream(path.join(folder, filename));
        res.data.pipe(writeStream);
        await new Promise<void>((resolve, reject) => stream.finished(writeStream, (err) => {
            if (err) {
                reject(err);
                return;
            }
            resolve();
        }));
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
    let articles: FullArticle[] = [];
    mkdir(output)
    mkdir(path.join(output, "articles"));
    mkdir(path.join(output, "images"));
    const files = unwrap(await drive.files.list({
        pageSize: 1000,
        q: `'${folder}' in parents and mimeType = 'application/vnd.google-apps.document'`,
        fields: "files(id, name)"
    })).files;
    for (let { id, name } of files ?? []) {
        console.log(`Processing "${name}"...`);
        if (!id || !name) {
            continue;
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
                if (!text || text.trim().toUpperCase() == name) {
                    continue;
                }
                body += text;
            }
        }
        articles.push({
            title: name,
            subtitle: body.split("\n")[0],
            body: body.trim(),
            image: await save(path.join(output, "images"), safeName(name),
                              Object.values(document.inlineObjects ?? {})[0]?.inlineObjectProperties?.embeddedObject?.imageProperties?.contentUri
                || Object.values(document.positionedObjects ?? {})[0]?.positionedObjectProperties?.embeddedObject?.imageProperties?.contentUri)
        });
        // await sleep(1000);
    }
    articles.sort((a: FullArticle, b: FullArticle): number => Number(Boolean(b.image)) - Number(Boolean(a.image)));
    articles = (await prompt([{
        type: "order-list",
        message: "Order parody articles by priority, most important first: ",
        name: "priority",
        choices: articles.map((article: FullArticle) => ({
            name: (article.image ? "🖼️" : "") + article.title,
            value: article
        }))
    }])).priority;
    const frontpage = await getPage(config.frontpage);
    if (config.default) {
        frontpage("a").attr("href", config.default);
    }
    fs.writeFileSync(path.join(output, "index.html"), processArticles(frontpage, normalize(config.frontpage.articles), articles, "./articles", "./images").html());
    let articlePage = await getPage(config.article);
    if (config.default) {
        articlePage("a").attr("href", config.default);
    }
    articlePage = processArticles(articlePage, normalize(config.article.links), articles, "./", "../images");
    for (let article of articles) {
        articlePage(config.article.title).text(article.title);
        articlePage(config.article.body).text(article.body);
        if (config.article.subtitle) {
            articlePage(config.article.subtitle).text(article.subtitle ?? "");
        }
        if (config.article.image) {
            if (article.image) {
                articlePage(config.article.image).replaceWith(`<img src="../images/${article.image}" />`);
            } else {
                articlePage(config.article.image).remove();
            }
        }
        fs.writeFileSync(path.join(output, "articles", safeName(article.title) + ".html"), articlePage.html());
    }
};
if (require.main === module) {
    auth(JSON.parse(fs.readFileSync(process.argv[3], "utf8")) as SavedCredentials)
        .then(oAuth2Client => spoof(YAML.parse(fs.readFileSync(process.argv[2], "utf8")) as Configuration, oAuth2Client, process.argv[4], process.argv[5]))
        .catch(error => console.error(error));
}
