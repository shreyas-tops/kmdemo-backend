## What is Node.js?
Node.js is a JavaScript runtime that allows us to run JavaScript outside the browser and build backend servers.

## What is Backend?
Backend is the server-side part of an application that handles logic, database, and APIs.
[Structure: Mobile App → Backend → Database]

## What is Express.js?
Express.js is a Node.js framework used to build APIs and backend servers easily.

Example:

```js
app.get("/users", (req, res) => {
  res.send("Users");
});
```

## What is API?
API is a way for frontend and backend to communicate.

Example:

```js
GET /customers
POST /orders
```

## What is Port?
Port is the number where server runs.

Example:

```js
http://localhost:3000
```

## What is package.json?
package.json stores project information and dependencies.

Example:

```js
express
nodemon
dotenv
```

## How to create project or project setup
```js
1. mkdir project_name
2. cd project_name
3. npm init -y [Initialize Node Project] :: this will create package.json file 
4. Install Core Libraries like 
     - npm install express :: Backend framework
     - npm install nodemon --save-dev :: Auto restart server
     - npm install cors :: Allow mobile app connection
     - npm install dotenv :: Environment variables

5. Create Production Folder Structure
     - mkdir src
     - mkdir src/config
     - mkdir src/controllers
     - mkdir src/routes
     - mkdir src/services
     - mkdir src/middleware
     - mkdir src/utils
     - mkdir src/models
     - mkdir uploads
   
   Create files:
     - touch server.js
     - touch .env
     - touch .gitignore
     - touch src/app.js

     project_name/
     │
     ├── src/
     │   ├── config/
     │   ├── controllers/
     │   ├── routes/
     │   ├── services/
     │   ├── middleware/
     │   ├── utils/
     │   ├── models/
     │   └── app.js
     │
     ├── uploads/
     │
     ├── .env
     ├── .gitignore
     ├── package.json
     └── server.js

6. Setup .gitignore :: open .gitignore file and past this three for intially 
     node_modules 
     .env
     uploads

7. Setup Environment Variables :: open .env 
     Add:
     ORT=3000

     Later:
     DATABASE_URL=
     JWT_SECRET=    

8. Add in  app.js
     const express = require("express");
     const cors = require("cors");
     require("dotenv").config();

     const app = express();

     // Middleware
     app.use(cors());
     app.use(express.json());

     // Test Route  
     app.get("/", (req, res) => {
          res.send("Catering API Running");
     });

     module.exports = app;

9. add in derver.json
     const app = require("./src/app");

     const PORT = process.env.PORT || 3000;

     app.listen(PORT, () => {
       console.log(`Server running on port ${PORT}`);
     });

10. Update package.json Scripts
     Find:

     "scripts": {
       "test": "echo \"Error: no test specified\" && exit 1"
     }

     Replace with:

     "scripts": {
       "start": "node server.js",
       "dev": "nodemon server.js"
     }

11. Start Server
     npm run dev
```

## What is Middleware?
Middleware is code that runs before the API executes. This converts JSON request into object.
Example:

```js 
app.use(express.json()) 
```

## What is .env File?
.env stores secret configuration values.
Example:

```js 
PORT=3000
DATABASE_URL=xxxx
JWT_SECRET=abc123
```

## What is nodemon?
nodemon automatically restarts server when code changes. using npm run dev

## Why Separate app.js and server.js?
app.js use for Express setup, routes setup and Middleware
server.js use for start server 

## Why Database Design First?
APIs depend on database. If database design changes later: APIs break, Code changes, Bugs increase So database should be designed first.

## What is a Table?
Table stores data in rows and columns.

## What is a Module?
Module is a group of related features. example customer module which include Add, Update, Delete and View 

## What is Database Relationship?
A database relationship defines how two tables are logically connected using primary and foreign keys. The three types are one-to-one, one-to-many, and many-to-many.

## What is Multi-Tenant Architecture?
One application serves multiple businesses. Data is isolated using business_id.

## What is SaaS? (Software as a Service)
Users subscribe and use the platform online.

## What is Multi-Tenant SaaS?
Single platform serving multiple businesses.

## What is Role-Based Access Control (RBAC)?
System where users have roles: Owner, Manager, Staff. Permissions depend on role.

## Why Design Database First?
Because: APIs depend on tables, Relationships affect logic, Bad schema = expensive rewrite

## What is a Core Entity?
Core entity is a central table that connects other modules.

## What is JWT? (JSON Web Token)
Used for secure authentication between client and server.

## What is Data Isolation?
Ensuring one business cannot access another business data.

## What is Prisma?
Prisma is an ORM (Object Relational Mapper) that allows us to interact with database using JavaScript instead of SQL.

## What is Migration?
Migration creates or updates database tables based on schema changes.

```js
npx prisma migrate dev
```

## What is DATABASE_URL?
Connection string that tells backend how to connect to database.

```js
postgresql://username:password@host:port/database_name
```

## What is Port 5432?
Default port for PostgreSQL.

## What is JWT_SECRET?
Secret key used to sign authentication tokens.


